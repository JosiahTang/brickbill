"""Render immutable page projections to PDF with ReportLab 4.4.9.

Input is JSON created by the Node adapter. No business query or template code is
executed here. Failures are reported as a single structured JSON line on stderr.
"""
import base64
import io
import json
import math
import os
import sys
from pathlib import Path

import reportlab
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

PX_PT = 72 / 96
MM_PT = 72 / 25.4
PAPER_MM = {"A4": (210, 297), "A3": (297, 420), "Letter": (215.9, 279.4), "Legal": (215.9, 355.6)}


class PdfLayoutError(Exception):
    def __init__(self, message, code="LAYOUT_OVERFLOW", **context):
        super().__init__(message)
        self.code = code
        self.context = context


def rgb(value, default=(0.12, 0.16, 0.22)):
    if isinstance(value, dict):
        value = value.get("argb") or value.get("rgb")
    if not isinstance(value, str):
        return default
    value = value.lstrip("#")
    if len(value) == 8:
        value = value[2:]
    if len(value) != 6:
        return default
    try:
        return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return default


class Fonts:
    def __init__(self, source):
        self.default = source["fallbackFont"]
        self.paths = {key.casefold(): value for key, value in source.get("fontMap", {}).items()}
        self.registered = {}
        self.used = set()
        if not Path(self.default).is_file():
            raise PdfLayoutError("PDF 兜底字体文件不存在", code="CONTRACT_INVALID", fontPath=self.default)

    def load(self, path):
        if path not in self.registered:
            if not Path(path).is_file():
                raise PdfLayoutError("PDF 字体文件不存在", code="CONTRACT_INVALID", fontPath=path)
            name = f"PDF_FONT_{len(self.registered) + 1}"
            try:
                pdfmetrics.registerFont(TTFont(name, path))
            except Exception as error:
                raise PdfLayoutError(f"无法嵌入 PDF 字体：{error}", code="CONTRACT_INVALID", fontPath=path) from error
            self.registered[path] = name
        return self.registered[path]

    def select(self, family, bold, text, page_number, address):
        key = (family or "").casefold()
        preferred = self.paths.get(f"{key}#bold" if bold else key) or self.paths.get(key) or self.default
        for path in dict.fromkeys((preferred, self.default)):
            name = self.load(path)
            cmap = pdfmetrics.getFont(name).face.charToGlyph
            missing = sorted({char for char in text if char not in "\r\n\t" and ord(char) not in cmap})
            if not missing:
                self.used.add(path)
                return name
        raise PdfLayoutError("PDF 字体缺少文字字形", pageNumber=page_number, cell=address,
                             characters="".join(missing[:12]), fontFamily=family)


def text_lines(text, font_name, font_size, max_width, wrap):
    result = []
    for paragraph in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not paragraph:
            result.append("")
            continue
        if not wrap:
            result.append(paragraph)
            continue
        line = ""
        for char in paragraph:
            if line and pdfmetrics.stringWidth(line + char, font_name, font_size) > max_width:
                result.append(line)
                line = char
            else:
                line += char
        result.append(line)
    return result


def paper_size(setup):
    if setup["paperSize"] == "custom":
        custom = setup.get("customPaperMm")
        if not custom:
            raise PdfLayoutError("自定义纸张缺少宽高", code="CONTRACT_INVALID")
        width, height = custom["width"], custom["height"]
    else:
        width, height = PAPER_MM[setup["paperSize"]]
    if setup["orientation"] == "landscape":
        width, height = max(width, height), min(width, height)
    else:
        width, height = min(width, height), max(width, height)
    return width * MM_PT, height * MM_PT


def cell_text(cell):
    if cell.get("binding"):
        raise PdfLayoutError("PDF 投影包含未解析的字段绑定", code="FIELD_NOT_FOUND")
    excel_value = cell.get("excelValue")
    if isinstance(excel_value, dict) and ("formula" in excel_value or "sharedFormula" in excel_value):
        raise PdfLayoutError("PDF 页面包含无法安全计算的公式", code="CONTRACT_INVALID")
    value = cell.get("text")
    if value is None:
        value = excel_value
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (str, int, float)):
        return str(value)
    if isinstance(value, dict) and "date" in value:
        return str(value["date"])
    return ""


def style_of(cell):
    style = (cell.get("styleEdits") if cell.get("excelStyle") else cell.get("style")) or {}
    raw = cell.get("excelStyle") or {}
    font = raw.get("font") or {}
    fill = raw.get("fill") or {}
    alignment = raw.get("alignment") or {}
    return {
        "family": style.get("fontFamily") or font.get("name") or "Arial",
        "size": style.get("fontSizePt") or font.get("size") or 11,
        "bold": style.get("bold", font.get("bold", False)),
        "color": rgb(style.get("color") or font.get("color")),
        "background": style.get("background") or (fill.get("fgColor") or {}).get("argb"),
        "horizontal": style.get("horizontal") or alignment.get("horizontal") or "left",
        "vertical": style.get("vertical") or alignment.get("vertical") or "middle",
        "wrap": style.get("wrap", alignment.get("wrapText", True)),
        "borders": style.get("borders") or raw.get("border") or {},
    }


def border(pdf, side, edge, x, y, width, height, scale):
    if not isinstance(edge, dict) or edge.get("style") in (None, "none"):
        return
    pdf.setStrokeColorRGB(*rgb(edge.get("color"), (0, 0, 0)))
    kind = edge["style"]
    pdf.setLineWidth((1.2 if kind in ("medium", "thick", "double") else 0.5) * scale)
    pdf.setDash(2 * scale, 2 * scale) if "dash" in kind or kind == "dotted" else pdf.setDash()
    if side == "top":
        pdf.line(x, y + height, x + width, y + height)
    elif side == "bottom":
        pdf.line(x, y, x + width, y)
    elif side == "left":
        pdf.line(x, y, x, y + height)
    else:
        pdf.line(x + width, y, x + width, y + height)
    pdf.setDash()


def render_page(pdf, page, source_images, resources, fonts, min_scale):
    setup = page["pageSetup"]
    doc = page["document"]
    page_w, page_h = paper_size(setup)
    pdf.setPageSize((page_w, page_h))
    rect = setup.get("printableRect") or {"r": 0, "c": 0, "rows": doc["rows"], "cols": doc["cols"]}
    row_heights = doc["rowHeightPx"]
    col_widths = doc["colWidthPx"]
    r0, c0 = rect["r"], rect["c"]
    r1, c1 = r0 + rect["rows"], c0 + rect["cols"]
    if r1 > len(row_heights) or c1 > len(col_widths):
        raise PdfLayoutError("PDF 打印范围超出工作表", pageNumber=page["pageNumber"])
    row_pos = [0]
    for height in row_heights:
        row_pos.append(row_pos[-1] + height)
    col_pos = [0]
    for width in col_widths:
        col_pos.append(col_pos[-1] + width)
    margins = setup["marginsMm"]
    width_pt = (col_pos[c1] - col_pos[c0]) * PX_PT
    height_pt = (row_pos[r1] - row_pos[r0]) * PX_PT
    free_w = page_w - (margins["left"] + margins["right"]) * MM_PT
    free_h = page_h - (margins["top"] + margins["bottom"]) * MM_PT
    scale = min(1, free_w / width_pt, free_h / height_pt)
    if not math.isfinite(scale) or scale < min_scale:
        raise PdfLayoutError("PDF 页面缩放过小，内容可能无法辨认", pageNumber=page["pageNumber"], scale=round(scale, 3))

    def at(position, widths):
        base = math.floor(position)
        if base < 0 or base >= len(widths):
            if base == len(widths) and position == base:
                return sum(widths)
            raise PdfLayoutError("图片定位超出工作表", pageNumber=page["pageNumber"])
        return sum(widths[:base]) + (position - base) * widths[base]

    def coords(r, c, rows, cols):
        left = margins["left"] * MM_PT + (at(c, col_widths) - col_pos[c0]) * PX_PT * scale
        top = page_h - margins["top"] * MM_PT - (at(r, row_heights) - row_pos[r0]) * PX_PT * scale
        width = (at(c + cols, col_widths) - at(c, col_widths)) * PX_PT * scale
        height = (at(r + rows, row_heights) - at(r, row_heights)) * PX_PT * scale
        return left, top - height, width, height

    merge_map = {(item["r"], item["c"]): item for item in doc.get("merges", [])}
    covered = set()
    for merge in doc.get("merges", []):
        for rr in range(merge["r"], merge["r"] + merge["rows"]):
            for cc in range(merge["c"], merge["c"] + merge["cols"]):
                if rr != merge["r"] or cc != merge["c"]:
                    covered.add((rr, cc))
    entries = sorted(doc.get("cells", {}).items(), key=lambda item: tuple(map(int, item[0].split(":"))))
    for address, cell in entries:
        r, c = map(int, address.split(":"))
        if (r, c) in covered or not (r0 <= r < r1 and c0 <= c < c1):
            continue
        merge = merge_map.get((r, c))
        rows, cols = (merge["rows"], merge["cols"]) if merge else (1, 1)
        if r + rows > r1 or c + cols > c1:
            raise PdfLayoutError("合并单元格越过打印范围", pageNumber=page["pageNumber"], cell=address)
        x, y, width, height = coords(r, c, rows, cols)
        style = style_of(cell)
        if style["background"]:
            pdf.setFillColorRGB(*rgb(style["background"], (1, 1, 1)))
            pdf.rect(x, y, width, height, fill=1, stroke=0)
        for side, edge in style["borders"].items():
            border(pdf, side, edge, x, y, width, height, scale)
        text = cell_text(cell)
        if not text:
            continue
        font_name = fonts.select(style["family"], style["bold"], text, page["pageNumber"], address)
        font_size = float(style["size"]) * scale
        padding = 2 * scale
        available_w = width - 2 * padding
        available_h = height - 2 * padding
        lines = text_lines(text, font_name, font_size, available_w, style["wrap"])
        if not style["wrap"] and any(pdfmetrics.stringWidth(line, font_name, font_size) > available_w + 0.2 for line in lines):
            raise PdfLayoutError("单元格不换行文字超出宽度", pageNumber=page["pageNumber"], cell=address)
        line_height = font_size * 1.1
        if len(lines) * line_height > available_h + 0.3:
            raise PdfLayoutError("单元格文字超过可用高度", pageNumber=page["pageNumber"], cell=address,
                                 requiredPt=round(len(lines) * line_height, 1), availablePt=round(available_h, 1))
        pdf.setFillColorRGB(*style["color"])
        pdf.setFont(font_name, font_size)
        vertical = style["vertical"]
        block_h = len(lines) * line_height
        if vertical in ("bottom", "BOTTOM"):
            baseline = y + padding + block_h - font_size
        elif vertical in ("top", "TOP"):
            baseline = y + height - padding - font_size
        else:
            baseline = y + (height + block_h) / 2 - font_size
        for line in lines:
            line_w = pdfmetrics.stringWidth(line, font_name, font_size)
            if style["horizontal"] in ("center", "CENTER"):
                line_x = x + (width - line_w) / 2
            elif style["horizontal"] in ("right", "RIGHT"):
                line_x = x + width - padding - line_w
            else:
                line_x = x + padding
            pdf.drawString(line_x, baseline, line)
            baseline -= line_height

    images = page.get("imagePlacements") or source_images.get(page["worksheetId"], [])
    for image in images:
        placement = image["rect"]
        ir, ic = placement["r"], placement["c"]
        irows, icols = placement["rows"], placement["cols"]
        if ir < r0 or ic < c0 or ir + irows > r1 or ic + icols > c1:
            raise PdfLayoutError("图片越过 PDF 打印范围", pageNumber=page["pageNumber"], imageId=image.get("imageId"))
        resource = resources.get(image.get("resourceId")) if image.get("resourceId") else image
        if not resource:
            raise PdfLayoutError("PDF 图片资源不存在", code="FIELD_NOT_FOUND", pageNumber=page["pageNumber"], imageId=image.get("imageId"))
        try:
            raw = base64.b64decode(resource["base64"], validate=True)
            reader = ImageReader(io.BytesIO(raw))
            x, y, width, height = coords(ir, ic, irows, icols)
            pdf.drawImage(reader, x, y, width=width, height=height, preserveAspectRatio=False, mask="auto")
        except Exception as error:
            raise PdfLayoutError(f"PDF 图片无法解码：{error}", code="CONTRACT_INVALID", pageNumber=page["pageNumber"], imageId=image.get("imageId")) from error
    pdf.showPage()
    return {"pageNumber": page["pageNumber"], "worksheetId": page["worksheetId"], "scale": round(scale, 4)}


def main():
    source_path, output_path = sys.argv[1:3]
    source = json.loads(Path(source_path).read_text(encoding="utf-8"))
    expected = source["reportlabVersion"]
    if reportlab.Version != expected:
        raise PdfLayoutError(f"ReportLab 版本不匹配：需要 {expected}，实际 {reportlab.Version}", code="CONTRACT_INVALID")
    pages = source["pages"]
    if not pages:
        raise PdfLayoutError("PDF 页面投影为空", code="CONTRACT_INVALID")
    fonts = Fonts(source)
    pdf = canvas.Canvas(output_path, pagesize=(595, 842), pageCompression=1, invariant=1)
    pdf.setTitle(source.get("title") or "Quality certificate")
    pdf.setAuthor("Brickbill Reporting")
    resources = {item["resourceId"]: item for item in source.get("resources", [])}
    details = [render_page(pdf, page, source.get("sourceImages", {}), resources, fonts,
                           source.get("minScale", 0.85)) for page in pages]
    pdf.save()
    print(json.dumps({"pageCount": len(details), "reportlabVersion": reportlab.Version,
                      "fontPaths": sorted(fonts.used), "pages": details}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except PdfLayoutError as error:
        print(json.dumps({"code": error.code, "message": str(error), "context": error.context}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"code": "CONTRACT_INVALID", "message": f"PDF 渲染失败：{error}"}, ensure_ascii=False), file=sys.stderr)
        sys.exit(3)
