export type MarkFormType =
  | "pass_fail"
  | "rubric"
  | "fields"
  | "text"
  | "tool";

export type PassFailChoice = "pass" | "fail" | "na";

export type MarkPayload = {
  form_type: MarkFormType;
  pass_fail?: PassFailChoice;
  why?: string;
  rubric?: Record<string, PassFailChoice>;
  fields?: Record<string, string>;
  expected_text?: string;
  tool?: { name: string; args: Record<string, unknown> };
};

export type CannotMarkPayload = {
  kind: "cannot_mark";
  reason: string;
};

export type StoredMark = MarkPayload | CannotMarkPayload;

export function isCannotMark(mark: StoredMark): mark is CannotMarkPayload {
  return "kind" in mark && mark.kind === "cannot_mark";
}

export function defaultFormType(scoreHow: "code" | "person"): MarkFormType {
  return scoreHow === "person" ? "pass_fail" : "pass_fail";
}

export function parseMarkPayload(raw: unknown): MarkPayload | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "cannot_mark") {
    return null;
  }
  const formType = obj.form_type;
  if (
    formType !== "pass_fail" &&
    formType !== "rubric" &&
    formType !== "fields" &&
    formType !== "text" &&
    formType !== "tool"
  ) {
    return null;
  }
  return obj as MarkPayload;
}

export function trimText(value: string): string {
  return value.trim();
}

export function normalizeMarkPayload(payload: MarkPayload): MarkPayload {
  const out: MarkPayload = { form_type: payload.form_type };
  if (payload.pass_fail != null) {
    out.pass_fail = payload.pass_fail;
  }
  if (payload.expected_text != null) {
    out.expected_text = trimText(payload.expected_text);
  }
  if (payload.why != null && payload.why.length > 0) {
    out.why = payload.why;
  }
  if (payload.rubric != null) {
    out.rubric = { ...payload.rubric };
  }
  if (payload.fields != null) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.fields)) {
      fields[k] = trimText(v);
    }
    out.fields = fields;
  }
  if (payload.tool != null) {
    out.tool = {
      name: payload.tool.name,
      args: { ...payload.tool.args },
    };
  }
  return out;
}

export function markFromFormBody(
  formType: MarkFormType,
  body: Record<string, unknown>,
): MarkPayload | CannotMarkPayload | null {
  const action = body.action;
  if (action === "cannot_mark") {
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length === 0) {
      return null;
    }
    return { kind: "cannot_mark", reason };
  }
  if (action !== "submit") {
    return null;
  }

  const payload: MarkPayload = { form_type: formType };

  if (formType === "pass_fail") {
    const pf = body.pass_fail;
    if (pf !== "pass" && pf !== "fail" && pf !== "na") {
      return null;
    }
    payload.pass_fail = pf;
    if (typeof body.expected_text === "string" && body.expected_text.length > 0) {
      payload.expected_text = body.expected_text;
    }
  } else if (formType === "text") {
    if (typeof body.expected_text !== "string" || body.expected_text.length === 0) {
      return null;
    }
    payload.expected_text = body.expected_text;
  } else if (formType === "fields") {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith("field_") && typeof value === "string") {
        fields[key.slice("field_".length)] = value;
      }
    }
    if (Object.keys(fields).length === 0) {
      return null;
    }
    payload.fields = fields;
  } else if (formType === "rubric") {
    const rubric: Record<string, PassFailChoice> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key.startsWith("rubric_") && (value === "pass" || value === "fail" || value === "na")) {
        rubric[key.slice("rubric_".length)] = value;
      }
    }
    if (Object.keys(rubric).length === 0) {
      return null;
    }
    payload.rubric = rubric;
  } else if (formType === "tool") {
    const name = body.tool_name;
    const argsRaw = body.tool_args;
    if (typeof name !== "string" || name.length === 0) {
      return null;
    }
    let args: Record<string, unknown> = {};
    if (typeof argsRaw === "string" && argsRaw.length > 0) {
      try {
        args = JSON.parse(argsRaw) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    payload.tool = { name, args };
  }

  if (typeof body.why === "string" && body.why.length > 0) {
    payload.why = body.why;
  }

  return payload;
}
