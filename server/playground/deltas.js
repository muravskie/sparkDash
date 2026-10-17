/**
 * OpenAI chat-completion chunk reducer for the playground relay.
 * Written here. It does not import a Tandem or llm-dashboard stream reader.
 */

/**
 * @returns {{ content: string, reasoning: string, toolCalls: { index: number, id: string, name: string, arguments: string }[] }}
 */
export function emptyTurn() {
  return { content: "", reasoning: "", toolCalls: [] };
}

/**
 * @param {{ content: string, reasoning: string, toolCalls: { index: number, id: string, name: string, arguments: string }[] }} state
 * @param {unknown} chunk
 */
export function reduceStreamDelta(state, chunk) {
  const next = {
    content: state?.content || "",
    reasoning: state?.reasoning || "",
    toolCalls: Array.isArray(state?.toolCalls) ? state.toolCalls.map((call) => ({ ...call })) : [],
  };
  if (!chunk || typeof chunk !== "object") return next;

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice || typeof choice !== "object") return next;

  const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : null;
  const message = choice.message && typeof choice.message === "object" ? choice.message : null;
  const textSource = delta || message;

  let addedContent = false;
  if (textSource && typeof textSource.content === "string" && textSource.content.length > 0) {
    next.content += textSource.content;
    addedContent = true;
  }
  if (textSource) {
    if (typeof textSource.reasoning === "string" && textSource.reasoning.length > 0) {
      next.reasoning += textSource.reasoning;
    } else if (typeof textSource.reasoning_content === "string" && textSource.reasoning_content.length > 0) {
      next.reasoning += textSource.reasoning_content;
    }
  }
  if (!addedContent && typeof choice.text === "string" && choice.text.length > 0) {
    next.content += choice.text;
  }

  const rawCalls = delta?.tool_calls || message?.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (let i = 0; i < rawCalls.length; i += 1) {
      const call = rawCalls[i];
      if (!call || typeof call !== "object") continue;
      const index = Number.isInteger(call.index) ? call.index : i;
      let slot = next.toolCalls.find((item) => item.index === index);
      if (!slot) {
        slot = { index, id: "", name: "", arguments: "" };
        next.toolCalls.push(slot);
      }
      if (typeof call.id === "string" && call.id) slot.id = slot.id ? slot.id : call.id;
      const fn = call.function && typeof call.function === "object" ? call.function : null;
      if (fn) {
        if (typeof fn.name === "string" && fn.name) slot.name += fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) slot.arguments += fn.arguments;
      }
    }
    next.toolCalls.sort((a, b) => a.index - b.index);
  }

  return next;
}
