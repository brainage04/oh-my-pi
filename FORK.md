# brainage04/oh-my-pi

A fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) that carries a few patches on top of each upstream release and publishes a prebuilt `omp-linux-x64` for Thomas's hosts.

## Branches and releases

- `local/patched-<upstream version>` holds one upstream release plus the fork's patches, for example `local/patched-19.2.1`.
- A release is tagged `v<upstream version>+bp.<n>`, for example `v19.2.1+bp.1`. `+bp.<n>` is semver build metadata, so the release compares equal to the upstream version. Releases up to `v19.1.1-bp.4` use `-bp.<n>`, which semver treats as a prerelease that sorts below upstream.
- Each release carries `omp-linux-x64`, `omp-browser-relay-extension.zip`, `LICENSE` and `SHA256SUMS`. `.github/workflows/fork-release.yml` builds them from a `v*+bp.*` tag push or a manual dispatch.
- `app-update` on Thomas's hosts picks the newest tag by upstream version, then by `<n>`, and pins it in `modules/omp-release.json` of the nixos-config repo.

## Patches carried

- A discarded turn stays in the session journal instead of rewriting the whole file, and two rewrites requested together publish one journal body.
- `omp --restore` and `omp --resume` of a session file under a named profile's root activate that profile, and `omp --restore` skips a subagent whose run already delivered its result.
- A session past the provider's image limit drops the oldest images a quarter of the limit at a time, so the prompt cache is not rewritten on every new image.
- GLM 4.7 and later on Z.ai hosts keep their earlier reasoning in context (`thinking.clear_thinking: false`), and DeepSeek reasoning models behind OpenRouter carry `reasoning_content` on every assistant turn.
- Idle prompt-cache warming keeps a 1-hour cache entry warm for 3 hours after the last request.
