<script setup lang="ts">
import type { ViewPreviewReply } from '../../services/reporting.ts';
defineProps<{ result: ViewPreviewReply; stale: boolean }>();
const emit = defineEmits<{ page: [offset: number] }>();
</script>
<template><section class="view-trial-results">
  <p>{{ result.mode === 'draft' ? '当前草稿试算' : result.mode === 'pinned' ? '模板固定版本试算' : '已发布视图试算' }} · 字段目录 {{ result.catalogVersion }} <strong v-if="stale">配置已修改，请重新试算</strong></p>
  <div class="button-row"><button :disabled="result.offset === 0" @click="emit('page',Math.max(0,result.offset-result.limit))">上一批结果</button><button :disabled="!result.views.some(view => view.truncated)" @click="emit('page',result.offset+result.limit)">下一批结果</button></div>
  <details v-for="view in result.views" :key="view.viewId" open><summary>{{ view.viewId }} · {{ view.viewVersion }} · 输入 {{ view.inputRecordCount }} / 输出 {{ view.outputRecordCount }} · 当前展示 {{ view.records.length }} 条</summary>
    <div style="overflow:auto;max-height:320px"><table><thead><tr><th>记录标识</th><th v-for="id in view.outputFields" :key="id">{{ id }}</th><th>来源记录</th></tr></thead><tbody><tr v-for="record in view.records" :key="record.recordId"><td>{{ record.recordId }}</td><td v-for="id in view.outputFields" :key="id">{{ record.values[id] }}</td><td>{{ record.sourceRecordIds.join('、') }}<details v-if="record.children"><summary>子集合（每组最多 {{ view.childrenLimitedTo }} 条）</summary><pre>{{ JSON.stringify(record.children,null,2) }}</pre></details></td></tr></tbody></table></div>
    <p v-for="(diagnostic,index) in view.diagnostics" :key="index">{{ diagnostic }}</p>
    <p v-if="view.childrenTruncated">子集合展示已达到本视图的 {{ view.childrenLimitedTo }} 条上限，可在对应子视图的表格中继续查看。</p>
  </details>
  <details v-if="result.pagePlan" open><summary>分页试算：{{ result.pagePlan.totalPages }} 页</summary><div v-for="page in result.pagePlan.pages" :key="page.pageNumber" class="region-card"><strong>第 {{ page.pageNumber }} 页 · {{ page.pageType }}</strong><small v-for="allocation in page.allocations" :key="allocation.regionId">{{ allocation.regionId }} · {{ allocation.recordIds.length }} 条记录 · 空白 {{ page.blankRows[allocation.regionId] ?? 0 }} 行</small><p v-for="(issue,index) in page.diagnostics" :key="index">{{ issue.message }} · {{ issue.context?.regionId }}</p></div></details>
</section></template>
