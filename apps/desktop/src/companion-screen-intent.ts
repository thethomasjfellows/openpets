const explicitScreenReference = /\b(?:my|this|that|current)\s+(?:screen(?:shot)?s?|desktop)\b|\b(?:on|at)\s+(?:my|the|this|that|current)\s+screen\b|\b(?:the|this|that|other|second|primary)\s+monitor\b|\bmonitor\s+(?:screen|display)\b/i;
const currentActivityRequest = /\bwhat(?:'s| is)\s+open\s*[?.!]*$|\bwhat\s+(?:apps?|windows?)\s+are\s+open\b|\bwhat(?:'s| is)\s+on\s+(?:my|the|this|that|current)\s+screen\b|\bwhat\s+am\s+i\s+(?:looking\s+at|working\s+on)\b/i;
const deicticVisualObject = /\b(?:this|that)\s+(?:app|chart|code|document|email|error|graph|image|message|page|photo|tab|video|website|window)\b/i;

export function isScreenDependentCompanionTurn(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return false;
  return explicitScreenReference.test(text)
    || currentActivityRequest.test(text)
    || deicticVisualObject.test(text);
}
