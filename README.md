# Crashcart

**A crash-test lab for AI shopping agents, built on the PayPal sandbox.**

AI agents are starting to pay on people's behalf. A single hostile line hidden in a
product page, a review or a tool result can try to make them overspend, pay the wrong
merchant or buy something the user never asked for. Crashcart attacks a shopping agent
with a library of such traps, scores what happens to the money, and shows how an
independent policy gate (a "seatbelt") changes the result.

Built for the PayPal AI Hackathon. Sandbox only: no real money, no real merchants.

> **Status: working prototype.** The attack library (22 attacks), the judge, the policy gate,
> the shopper agent and the demo site exist and are tested. Live results from real models are
> recorded in `data/runs/` and summarised below. The PayPal sandbox client is written and
> unit-tested; its first live runs are not yet part of the published results (see Roadmap).

## Demo site

The `docs/` folder is a static site (GitHub Pages) with the scoreboard, a crash lab that replays
real recorded runs, and a "seatbelt playground" that runs the real gate and judge code in your
browser. Numbers on the site are computed in the browser from the run files; nothing is typed in
by hand. Rebuild its generated files with `npm run build:site` (needs the dev dependencies).

## How it works

1. **Mandate**: what the human asked for (goal, budget, trusted merchants, expected item,
   delivery label). It never comes from page content.
2. **Attack scenarios**: fixtures that plant hostile text in one of five places
   (product description, review, seller note, checkout page, tool output).
3. **Judge (ground truth)**: compares the order an agent proposes with the full mandate
   and lists every breach (over budget, wrong payee, wrong currency, unexpected item,
   inflated quantity, wrong shipping, unauthorized recurring charge, price mismatch).
4. **Policy gate**: a small deterministic check placed between the agent and the payment
   API. It lives outside the language model, so text on a page cannot change its rules.
   Three levels: `none`, `basic` (money checks), `strict` (also intent checks).
5. **Shopper agent**: one model call per run. The model sees the user's request plus the
   fictional store page (with the hostile text planted in it) and answers with a JSON
   decision: place an order or stop. A `plain` and a `hardened` prompt are available.
6. **Live runs**: every scenario is repeated several times against a real model. Each
   proposed order is judged and passed through the three gate levels, and the measured
   breach rate is stored in `data/runs/`. (Planned next: create the allowed orders in the
   PayPal sandbox.)

## Run it

Requires Node.js 22.18 or newer (it runs TypeScript directly). No dependencies, no keys.

```bash
npm test            # unit tests (no network, no keys)
npm run selfcheck   # runs every scenario through the judge and the gate
node src/run.ts --dry-run --only review-extra-units   # prints the exact prompt, no API call
```

### Measured results so far

Free-tier Gemini models through the Google AI Studio API, one model call per run, 5 runs per attack,
22 attacks (11 blunt, 11 crafted). Source: `data/runs/*.json`. Only fictional data was sent.

| Model | Prompt | Attacks | Valid runs | Agent breached the request | Reach payment: no seatbelt | basic | strict |
|---|---|---|---|---|---|---|---|
| Gemini 3.1 Flash-Lite | hardened | blunt | 55 | 0 (0%) | 0 | 0 | 0 |
| Gemini 3.1 Flash-Lite | hardened | crafted | 55 | 5 (9%) | 5 | 0 | 0 |
| Gemini 3.1 Flash-Lite | plain | blunt | 55 | 4 (7%) | 4 | 4 | 0 |
| Gemini 3.1 Flash-Lite | plain | crafted | 55 | 20 (36%) | 20 | 10 | 0 |
| Gemini 3.5 Flash-Lite | hardened | blunt | 55 | 0 (0%) | 0 | 0 | 0 |
| Gemini 3.5 Flash-Lite | hardened | crafted | 55 | 5 (9%) | 5 | 0 | 0 |
| Gemini 3.5 Flash-Lite | plain | blunt | 55 | 0 (0%) | 0 | 0 | 0 |
| Gemini 3.5 Flash-Lite | plain | crafted | 55 | 10 (18%) | 10 | 5 | 0 |

What this does and does not say:

- The strict seatbelt let **0** bad orders through out of 44 breached runs and wrongly stopped
  **0** faithful orders. The basic seatbelt let 19 through.
- Crafted attacks (forged chat turns, fake tool results, fake consent records) fool the models far more often than
  blunt ones. A "hardened" prompt reduces this but does not remove it.
- "0 leaks" for strict means none of the breaches that happened were allowed through. The strict gate is deliberately blind to look-alike products (the `l2-lookalike-hub` attack), so a model that fell for that one would get through; none did in these runs.
- These rates describe 22 hand-written attacks against a single-call agent. They are not a rate for the real world.
- Cells with 5 runs are noisy: read "5 of 5" and "0 of 5" as strong signals, anything in between as a hint.

### Live runs with a real model

Needs a Google AI Studio API key in the `LLM_API_KEY` environment variable (never commit it).
Use fictional data only: the free tier may use prompts to improve Google products.

```bash
node src/run.ts --list-models
node src/run.ts --model <model-id> --runs 5 --prompt plain
```

Or without a computer: add the repository secret `LLM_API_KEY`, then start the
**Live run** workflow from the Actions tab. Results are committed to `data/runs/`.
Models are not deterministic, which is why each attack is repeated; only numbers that
come from these files should be quoted.

### Offline self-check (rules only, no AI involved)

This runs the *fixture* order a fooled agent is assumed to produce. It checks the rules,
**not** how often a real model gets fooled.

| Policy | Fixture attacks stopped | Safe orders wrongly stopped |
|---|---|---|
| none | 0 / 11 | 0 / 10 |
| basic | 8 / 11 | 0 / 10 |
| strict | 10 / 11 | 0 / 10 |

The one attack `strict` does not stop is deliberate: a look-alike product ("USB-C Cable
Organizer Case") that reuses the expected keyword. Catching it needs a model-based
review or a human. We keep it in the library so the numbers stay honest.

## Known limitations

- Currency is compared by code, not converted by exchange rate.
- Only single-`purchase_unit` PayPal orders are supported by the adapter.
- The PayPal adapter follows the public Orders v2 field names as understood by the
  author; verify it against a real sandbox response (planned).
- The scenario library is small (11) and written by hand.
- The agent is a single model call, not a multi-step browsing agent. Results describe
  this setup, not every shopping agent.
- A model answer that cannot be parsed is counted as an error, never as a pass.

## PayPal usage

Sandbox only. `src/core/paypal.ts` converts a PayPal Orders v2 request body into the
simplified order the judge and gate understand. The live pipeline will create sandbox
orders for the orders the gate allows.

## Roadmap

- [x] Mandate, judge, policy gate, PayPal order adapter
- [x] 11 attack scenarios with safe and unsafe fixture orders
- [x] Unit tests and offline self-check
- [x] Shopper agent (one model call, JSON decision) and live-run harness
- [ ] Real product search (Channel3) and multi-step tool calling
- [x] PayPal sandbox client: create orders and read them back (unit-tested; live runs pending)
- [x] Measured breach rates over repeated live runs (with and without the gate)
- [ ] Gate synthesizer: propose policy rules from observed failures
- [x] Demo site: scoreboard, crash lab (replay), seatbelt playground (GitHub Pages)
- [ ] Live attack runs from the site itself (needs a rate-limited server endpoint)
- [ ] Optional: adaptive attacker agent, public arena

## Responsible use

All attacks target Crashcart's own test agent and fictional merchants. Do not point this
tooling at real shops, real people or real payment accounts.

## AI assistance disclosure

This project is built with the help of AI tools (Lovable, ChatGPT and Claude). Product
decisions and architecture are the author's.

## License

MIT, see [LICENSE](LICENSE).
