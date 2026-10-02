import json
import os
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
results=[]
with sync_playwright() as p:
 executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
 browser=p.chromium.launch(**({'executable_path':executable} if executable else {}),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1,accept_downloads=True)
 errors=[]; network=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r:network.append(r.url) if r.url.startswith(('http:','https:')) else None)
 page.set_content((root/'preview/index.html').read_text(), wait_until='load')
 def check(name, condition):
  assert condition,name
  results.append({'name':name,'passed':True})
 check('Initial example has 4 blocks and 10 bindings',page.locator('#counts').inner_text()=='4 个积木 · 10 个绑定')
 check('Customer placeholder rendered',page.locator('td[data-r="2"][data-c="1"]').inner_text()=='{{customer.name}}')
 check('Title merge rendered',page.locator('td[data-r="0"][data-c="0"]').get_attribute('colspan')=='4')
 page.screenshot(path=str(root/'docs/offline-preview.png'),full_page=True)
 # Actual HTML drag-and-drop, not direct state mutation.
 page.locator('.material[data-id="customer-info"]').drag_to(page.locator('td[data-r="12"][data-c="0"]'))
 check('HTML5 block drop commits',page.locator('#counts').inner_text()=='5 个积木 · 14 个绑定')
 rev=page.locator('#revision').inner_text()
 page.locator('.material[data-id="customer-info"]').drag_to(page.locator('td[data-r="12"][data-c="0"]'))
 check('Occupied region rejects overwriting',page.locator('#revision').inner_text()==rev and '已有积木' in page.locator('#status').inner_text())
 page.locator('#undo').click()
 check('Undo restores previous document',page.locator('#counts').inner_text()=='4 个积木 · 10 个绑定')
 page.locator('#redo').click()
 check('Redo restores block',page.locator('#counts').inner_text()=='5 个积木 · 14 个绑定')
 page.locator('#undo').click()
 page.locator('.field[data-id="orderDate"]').drag_to(page.locator('td[data-r="14"][data-c="0"]'))
 check('Field drop generates placeholder',page.locator('td[data-r="14"][data-c="0"]').inner_text()=='{{orderDate}}')
 rev=page.locator('#revision').inner_text()
 page.locator('.field[data-id="items.price"]').drag_to(page.locator('td[data-r="15"][data-c="0"]'))
 check('Collection field rejected outside repeat area',page.locator('#revision').inner_text()==rev and '重复区域' in page.locator('#status').inner_text())
 page.locator('td[data-r="2"][data-c="1"]').click()
 page.locator('#binding').select_option('orderNo');page.locator('#apply-binding').click()
 check('Explicit field replacement',page.locator('td[data-r="2"][data-c="1"]').inner_text()=='{{orderNo}}')
 page.locator('td[data-r="16"][data-c="0"]').click()
 page.locator('td[data-r="16"][data-c="1"]').click(modifiers=['Shift'])
 page.locator('#merge').click()
 check('Shift selection merges cells',page.locator('td[data-r="16"][data-c="0"]').get_attribute('colspan')=='2')
 page.locator('#background').evaluate('(el)=>el.value="#ffe8bd"')
 page.locator('#font-size').fill('14');page.locator('#apply-style').click()
 check('Background property applied',page.locator('td[data-r="16"][data-c="0"]').evaluate('(el)=>getComputedStyle(el).backgroundColor')=='rgb(255, 232, 189)')
 page.locator('#row-height').fill('52');page.locator('#col-width').fill('185');page.locator('#apply-size').click()
 check('Row dimensions applied',page.locator('td[data-r="16"][data-c="0"]').evaluate('(el)=>Math.round(el.getBoundingClientRect().height)')==52)
 page.locator('#unmerge').click()
 check('Unmerge restores separate cells',page.locator('td[data-r="16"][data-c="1"]').count()==1)
 # Drop near the last column must be rejected, not clipped.
 rev=page.locator('#revision').inner_text()
 target=page.locator('td[data-r="19"][data-c="11"]');target.scroll_into_view_if_needed()
 page.locator('.material[data-id="customer-info"]').drag_to(target)
 check('Out-of-bounds drop rolls back',page.locator('#revision').inner_text()==rev and '超出画布' in page.locator('#status').inner_text())
 # Verify browser download output contains source document + metadata.
 with page.expect_download() as info:
  page.locator('#export-json').click()
 download=info.value
 payload=json.loads(Path(download.path()).read_text())
 check('JSON download contains validated model and metadata',payload['document']['schemaVersion']==1 and isinstance(payload['metadata'],dict) and payload['document']['cells']['2:1']['binding']['path']=='orderNo')
 # The right-hand move handle uses the same domain move transaction.
 page.locator('td[data-r="2"][data-c="1"]').click()
 target=page.locator('td[data-r="22"][data-c="0"]');target.scroll_into_view_if_needed()
 page.locator('#move-handle').drag_to(target)
 check('Whole-block drag preserves edited binding',page.locator('td[data-r="22"][data-c="1"]').inner_text()=='{{orderNo}}' and page.locator('td[data-r="2"][data-c="1"]').inner_text()=='')
 page.locator('#undo').click()
 check('Undo restores moved block',page.locator('td[data-r="2"][data-c="1"]').inner_text()=='{{orderNo}}')
 page.locator('td[data-r="17"][data-c="0"]').click()
 rev=page.locator('#revision').inner_text()
 page.locator('#row-height').fill('5');page.locator('#apply-size').click()
 check('Invalid dimensions reject without mutation',page.locator('#revision').inner_text()==rev and '行高' in page.locator('#status').inner_text())
 page.once('dialog',lambda d:d.accept());page.locator('#new-doc').click()
 check('New blank document is undoable',page.locator('#counts').inner_text()=='0 个积木 · 0 个绑定')
 page.locator('#undo').click()
 check('Undo new document restores design',page.locator('#counts').inner_text()=='4 个积木 · 11 个绑定')
 check('No external network requests',not network)
 check('No browser page errors',not errors)
 browser.close()
 report={'runner':'Playwright Python + system Chromium','entry':'preview/index.html loaded via Playwright set_content (file navigation blocked by container policy)','results':results,'passed':len(results),'pageErrors':errors,'externalRequests':network}
 (root/'docs/offline-preview-test-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps(report,ensure_ascii=False,indent=2))
