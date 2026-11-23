# Agnes: Codex subagent model and effort

The **Follow Agnes model selection** choice in Settings → Local engines → Codex changes how the next turn's model advice is presented. Agnes itself is configured in Settings → Subagents. The existing native defaults are preserved. When the spawn tool accepts explicit overrides, the parent is instructed to pass the recommended model and, when verified, the recommended reasoning effort for the delegated task. The model still decides whether delegation is useful; this is not interception of the native tool or a change to the parent model. Explicit user choices take precedence.

## Reference snapshot (2026-11-23)

- [Codex Radar](https://codexradar.com/en/): the November 22 Codex community matrix provides same-suite measurements per model and effort. Its USD column is a reference estimate and is **not** subscription billing.
- [Artificial Analysis OpenAI benchmark results](https://artificialanalysis.ai/providers/openai/) and [methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking): independent, per-effort API quality and time measurements. Different tasks, harness and scales; do not average these scores or merge the times or costs across sites.
- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection), [reasoning support](https://developers.openai.com/api/docs/guides/deployment-checklist) and [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): capability bounds, workload guidance and native per-spawn controls. The local Codex catalog ultimately gates each override.

| Exact model ID | Light | Standard | Difficult | Why |
| --- | --- | --- | --- | --- |
| `gpt-6.2-astra` | low | high | xhigh | Both benchmark environments show gains over low. In the Radar snapshot, max adds little quality beyond xhigh while taking substantially longer. |
| `gpt-6.2-sol` | low | medium | high | OpenAI suggests medium as a starting point for routine work. Both benchmarks show a high-over-medium gain; extra gains above high varied, so high is the conservative default for difficult delegated work. |
| `gpt-6.1-terra` | low | high | xhigh | Both benchmarks favor xhigh over high on quality. Max is slower in both, so don't default to it. The sources disagree on some lower-effort quality ordering; low here prioritizes latency, not maximum quality. |

These are versioned defaults, not live scraping. No prompts or account data go to benchmark sites. No effort override is proposed for an unverified ID, an effort missing from the current Codex catalog, or a non-native route. Models are still limited to user-selected, available candidates. Freshly unverified reference data, no recommendation, or unsupported controls leave native behavior intact.
