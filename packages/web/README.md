# @glass/web

The browser SDK for [Glass](https://github.com/ISNIT0/glass-analytics): open-source, agent-first analytics that runs in your own Cloudflare account.

You need a Glass deployment first: run `npx glass init` in your project.

```sh
npm i @glass/web
```

```ts
import { glass } from '@glass/web';

glass.init({ host: 'https://glass.acme.workers.dev', project: 'acme' });

glass.capture('signup_completed', { plan: 'pro' });
glass.identify(user.id, { plan: user.plan });

if (glass.flag('new-checkout') === 'test') showNewCheckout();
```

Pageviews (including client-side navigation), clicks, errors and web vitals are captured automatically. About 4 KB gzipped, no dependencies. Session replay loads a separate recorder from your Worker only for recorded sessions.

No build step? Use the script tag your Worker serves instead:

```html
<script defer src="https://glass.acme.workers.dev/s.js" data-project="acme"></script>
```

Full reference: [docs/sdk.md](https://github.com/ISNIT0/glass-analytics/blob/main/docs/sdk.md). License: MIT.
