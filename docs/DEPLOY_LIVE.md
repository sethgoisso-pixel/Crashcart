# Deploying the live endpoint (Cloudflare Workers, free plan)

1. Create a free Cloudflare account and open Workers & Pages.
2. Create a Worker (Hello World template) and name it, for example, `crashcart`.
3. Edit its code and replace everything with the content of `worker/worker.js`, then Deploy.
4. In the Worker's Settings > Variables and Secrets, add three **secrets**:
   `LLM_API_KEY` (Google AI Studio key), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (PayPal *sandbox* app).
5. Open `https://<worker>.<account>.workers.dev/health`. It should show `"llm":true,"paypal":true`.
6. Put the Worker's address in `docs/config.js` (`LIVE_URL`). GitHub Pages then serves the live demo.

Optional variable `ALLOWED_ORIGIN` changes the one website allowed to call the Worker
(default: `https://sethgoisso-pixel.github.io`).

To run the same code on your own machine, see `src/run.ts` (command line) and the tests in `tests/worker.test.ts`.
