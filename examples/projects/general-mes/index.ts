import type { ExampleTemplateSpec } from '../quality-templates.ts';

/** Different physical source names and a different business entry key use the same engine. */
export const generalMesTemplates: ExampleTemplateSpec[] = [
  { projectId: 'general-mes-demo', templateId: 'general-mes-certificate-v1', name: 'MES 质保书示例', variant: 'certificate' },
  { projectId: 'general-mes-demo', templateId: 'general-mes-customer-v1', name: 'MES 客户版质保书示例', variant: 'customer' },
];
