export const AGENT_KEYS = [
  "ceo",
  "marketing",
  "sales",
  "operations",
  "finance",
  "rnd",
  "engineering",
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentDefinition {
  key: AgentKey;
  name: string;
  nameAr: string;
  descriptionAr: string;
  /** Task types this agent can execute today. Empty = not implemented yet. */
  taskTypes: readonly string[];
  /** Whether running this agent needs a configured AI provider. */
  requiresAi: boolean;
  /** Tools the agent may use. Each one also needs an org-level permission row. */
  tools: readonly string[];
}

/**
 * Static agent catalogue. Capabilities listed here are backed by code.
 * Agents with no task types show as "not available yet" in the UI.
 */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    key: "ceo",
    name: "CEO Agent",
    nameAr: "المدير التنفيذي الذكي",
    descriptionAr:
      "يستقبل طلبات المدير، يقسّمها إلى مهام فرعية ويوزعها على الوكلاء، ويطلب موافقة بشرية قبل التنفيذ. لا يعتمد العمليات الحساسة بنفسه.",
    taskTypes: ["ceo.plan"],
    requiresAi: true,
    tools: ["tasks.create_subtasks"],
  },
  {
    key: "marketing",
    name: "Marketing Agent",
    nameAr: "وكيل التسويق",
    descriptionAr: "يكتب مسودات المحتوى ومنشورات Instagram والنصوص الإعلانية ويجهزها للمراجعة.",
    taskTypes: ["marketing.draft_content"],
    requiresAi: true,
    tools: ["content.create_version"],
  },
  {
    key: "sales",
    name: "Sales Agent",
    nameAr: "وكيل المبيعات",
    descriptionAr: "إدارة العملاء المحتملين ومسار المبيعات ورسائل المتابعة. مخطط له في المرحلة 7.",
    taskTypes: [],
    requiresAi: true,
    tools: [],
  },
  {
    key: "operations",
    name: "Operations Agent",
    nameAr: "وكيل العمليات",
    descriptionAr:
      "يفحص المهام المتأخرة والفاشلة والأقفال العالقة في الطابور ويقدّم تقريرًا. لا ينفذ تغييرات إنتاجية.",
    taskTypes: ["operations.health_check"],
    requiresAi: false,
    tools: ["tasks.read"],
  },
  {
    key: "finance",
    name: "Finance Agent",
    nameAr: "وكيل التحليل المالي",
    descriptionAr:
      "يلخص استهلاك النماذج وتكلفتها من السجلات الفعلية فقط. لا يقدّم أرقامًا تقديرية على أنها فعلية.",
    taskTypes: ["finance.ai_usage_report"],
    requiresAi: false,
    tools: ["usage.read"],
  },
  {
    key: "rnd",
    name: "R&D Agent",
    nameAr: "وكيل البحث والتطوير",
    descriptionAr: "تحليل المنافسين والفرص من مصادر مسموح بها. لم يُفعّل بعد.",
    taskTypes: [],
    requiresAi: true,
    tools: [],
  },
  {
    key: "engineering",
    name: "Engineering Agent",
    nameAr: "وكيل الهندسة",
    descriptionAr: "تحليل الأخطاء والسجلات واقتراح إصلاحات. لا ينشر إلى الإنتاج. لم يُفعّل بعد.",
    taskTypes: [],
    requiresAi: true,
    tools: [],
  },
];

export function agentForTaskType(taskType: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((a) => a.taskTypes.includes(taskType));
}

export function getAgentDefinition(key: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((a) => a.key === key);
}
