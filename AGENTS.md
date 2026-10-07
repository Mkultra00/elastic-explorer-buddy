<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- CHONK RADAR server logic (Socrata, Elastic, Mistral) lives in `src/lib/chonk.server.ts`; `chonk.functions.ts` dynamically imports it inside handlers so secrets never reach the client.
- Mistral classification runs in small batches driven by a client loop, because Worker requests time out and Mistral rate-limits.
- Map is a plain SVG projection (no map library) to stay SSR-safe and dependency-free.
