# Built-in Agnes dispatch hook

PixelSky ships this component as an application resource, not a store extension. When an Agnes dispatch mode is enabled, PixelSky registers the bundled local marketplace and installs this hook through the native Codex CLI in the selected local profile. Nothing is downloaded. Outside a PixelSky dispatch session the hook is inert. Removing or disabling trust is respected; PixelSky never writes the trust state.

Use Codex's `/hooks` to review and approve **Agnes is evaluating the delegated task**, then reopen the PixelSky session. The hook uses Node.js 20+ (including PixelSky's private Node when available). The selected mode uses the task passed to the native agent tool, not the parent conversation. Enforcement blocks intercepted dispatches that cannot use an override or do not yield a configured model.

[Codex Hooks](https://learn.chatgpt.com/docs/hooks)
