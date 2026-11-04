# Flags and experiments

## Flags

A flag has a rollout percentage, optional variants, and optional targeting rules:

```json
{
  "key": "new-checkout",
  "enabled": true,
  "rollout": 50,
  "variants": [{ "key": "control", "weight": 50 }, { "key": "test", "weight": 50 }],
  "rules": [
    {
      "conditions": [{ "property": "person.plan", "value": "enterprise" }],
      "rollout": 100,
      "variant": "test"
    }
  ]
}
```

- **Evaluation** happens in your Worker (`POST /f`), so rules that mention person properties never reach browsers. The SDK caches values on the device.
- **Assignment** is a hash of the flag key, an optional `salt` and the device's `distinct_id`, so it's stable without storing anything, and identical wherever it's computed. Glass hashes the device id rather than the user id because the device id doesn't change at login, so signing in never flips someone's variant.
- **Rules** are checked in order; the first rule whose conditions all match sets the rollout (and optionally forces a variant). Conditions use the same property syntax as query filters: `person.*`, `country`, `device`, `browser`, `os`.
- Change the `salt` to reshuffle everyone.

```sh
npx @glassanalytics/cli flags set beta-editor --rollout 10
npx @glassanalytics/cli flags set beta-editor --rules '[{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}]'
```

## Experiments

An experiment is a multivariate flag plus a goal event:

```sh
npx @glassanalytics/cli experiments create checkout-v2 --goal purchase_completed --hypothesis "A one-page checkout converts better"
```

This creates the experiment as a draft, plus a `checkout-v2` flag with `control` and `test` at 50/50, disabled until you start. In code, read the flag where the variant is shown:

```js
if (glass.flag('checkout-v2') === 'test') renderOnePageCheckout();
```

Then `npx @glassanalytics/cli experiments start checkout-v2`, wait, and read `npx @glassanalytics/cli experiments results checkout-v2`. Ship the winner with `npx @glassanalytics/cli experiments ship checkout-v2 test`; everyone gets that variant from then on.

## How results are computed

- A person enters at their **first `$exposure`** to the flag. People exposed to more than one variant are excluded and counted separately; if that number is large, the flag is being read inconsistently.
- A person **converts** if they do the goal event at or after their first exposure.
- **Conversion rate** per variant comes with a 95% Wilson interval.
- **Probability to beat control** and the **lift interval** come from a Bayesian beta-binomial model with a uniform prior, estimated with 20,000 seeded Monte Carlo draws (the same data always gives the same numbers).
- With a `value` property on the goal (e.g. revenue), Glass also compares **means per person** with Welch's t-test.
- **Sample ratio mismatch**: a chi-square test of exposures against the variant weights. If p < 0.001, Glass flags the experiment as broken and won't declare a winner, because assignment or exposure tracking is faulty.
- A **winner** is declared at ≥ 95% probability to beat control. Until then, Glass estimates the days needed to detect a 10% relative lift at the current traffic.

The statistics live in `packages/core/src/stats/tests.ts` with tests against known values.
