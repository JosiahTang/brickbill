import type { ExampleTemplateSpec } from '../quality-templates.ts';

/** Simulated reference project; physical source names are mapped in example-projects.ts. */
export const dalipuTemplates: ExampleTemplateSpec[] = [
  { projectId: 'dalipu-demo', templateId: 'dalipu-certificate-v1', name: '达力普质保书示例', variant: 'certificate' },
  { projectId: 'dalipu-demo', templateId: 'dalipu-customer-v1', name: '达力普客户版质保书示例', variant: 'customer' },
];
