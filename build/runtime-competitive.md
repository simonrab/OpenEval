# EvalRouter Live — competitive notes

**Status:** research. Not product truth. Spec: [EVALROUTER_RUNTIME_REQUIREMENTS.md](../EVALROUTER_RUNTIME_REQUIREMENTS.md).  
**Date:** 26 August 2026.

## Empty gap

Gateways sell unified API + fallback + logs + dashboard (LiteLLM, Portkey, Helicone, OpenRouter `models[]`, Cloudflare, Vercel, Kong, TrueFoundry, Bifrost). Learned pickers re-decide per request (Not Diamond, RouteLLM, Bedrock Intelligent Prompt Routing, OpenRouter Auto). Observability scores after the fact (Braintrust, Langfuse, LangSmith) and leaves you to change config in a UI.

Nobody ships: eval-compiled `{primary, backups, eval_set_version}` + agent-native apply + human gate + ≪5 ms in-process hop + live miss → draft eval.

## Steal

- OpenRouter / Vercel `models` fallback array (execute the blob; do not rebuild the marketplace)
- Portkey canary as a traffic weight (ours is 5% tied to an eval-set version)
- Bifrost in-process SDK latency story (~µs class claims; we need p99 ≤ 5 ms)
- Braintrust / Langfuse async capture and sampling; never block the user
- Kong / TrueFoundry stable alias idea (we pin `pol_`, not a virtual-model YAML)

## Refuse

- Hosted dashboard as the product
- Per-request classifier / Auto / Not Diamond select (50–200 ms, not your frozen job)
- LLM-as-judge or full suite on the request
- Prompt rewrite / per-target prompt versions
- Competing as “another LiteLLM”
- Extra hop of +20–60 ms sold as “fine vs 2 s generation”

## Closest threats

- Braintrust: evals near a gateway, still dashboard, failover is same-model other provider
- Not Diamond: train on your evals, still per-request, misses ≪5 ms

Enter the compile-and-apply gap. Do not enter the commodity proxy. Do not enter the classifier.
