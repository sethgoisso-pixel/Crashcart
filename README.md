# Crashcart

**A crash-test lab for AI shopping agents, built on the PayPal sandbox.**

AI agents are starting to pay on people's behalf. A single hostile line hidden in a
product page, a review or a tool result can try to make them overspend, pay the wrong
merchant or buy something the user never asked for. Crashcart attacks a shopping agent
with a library of such traps, scores what happens to the money, and shows how an
independent policy gate (a "seatbelt") changes the result.

Built for the PayPal AI Hackathon. Sandbox only: no real money, no real merchants.

> **Status: early prototype.** The decision logic and the attack library exist and are
> tested. The live shopper agent, the PayPal sandbox calls and the web UI are **not built
> yet** (see Roadmap). Nothing below claims results from a real AI agent.

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
5. **Live runs (planned)**: a real model-driven agent shops against the scenarios, the
   proposed order is created in the PayPal sandbox only if the gate allows it, and the
   measured breach rate is reported with and without the gate.

## Run it

Requires Node.js 22.18 or newer (it runs TypeScript directly). No dependencies, no keys.

```bash
npm test            # 11 unit tests
npm run selfcheck   # runs every scenario through the judge and the gate
```

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

## PayPal usage

Sandbox only. `src/core/paypal.ts` converts a PayPal Orders v2 request body into the
simplified order the judge and gate understand. The live pipeline will create sandbox
orders for the orders the gate allows.

## Roadmap

- [x] Mandate, judge, policy gate, PayPal order adapter
- [x] 11 attack scenarios with safe and unsafe fixture orders
- [x] Unit tests and offline self-check
- [ ] Shopper agent with tool calling and real product search
- [ ] Create orders in the PayPal sandbox and read them back
- [ ] Measured breach rates over repeated live runs (with and without the gate)
- [ ] Gate synthesizer: propose policy rules from observed failures
- [ ] Web UI: live attack timeline, scoreboard, before/after
- [ ] Optional: adaptive attacker agent, public arena

## Responsible use

All attacks target Crashcart's own test agent and fictional merchants. Do not point this
tooling at real shops, real people or real payment accounts.

## AI assistance disclosure

This project is built with the help of AI tools (Lovable, ChatGPT and Claude). Product
decisions and architecture are the author's.

## License

MIT, see [LICENSE](LICENSE).
