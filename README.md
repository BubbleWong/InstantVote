# InstantVote

InstantVote is a modern multiple-choice voting app built with Node.js, Koa, and PostgreSQL.

## Features

- Username-based accounts for voting-session owners
- UUID-based sessions, answers, votes, and anonymous guests
- QR codes and public voting links
- Changeable votes with automatic live results
- Device-based voting history
- Soft-deleted voting sessions

## Setup

Requirements: Node.js 22.13 or newer and PostgreSQL.

```bash
npm install
cp .env.example .env
set -a; source .env; set +a
npm run db:migrate
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Production deployment

The PM2 configuration runs InstantVote on port **3002**. Configure PostgreSQL
environment variables first, or use the existing sibling
`../Capture-Quest/server/runtimeConfig.js` configuration. Never commit credentials.

```bash
npm ci --omit=dev
npm run build
pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
```

Enable PM2's startup service with `pm2 startup` if it is not already configured.
Route the Cloudflare Tunnel to `http://127.0.0.1:3002`; HTTPS is terminated by
Cloudflare. The deployed site is [iv.bubbleh.com](https://iv.bubbleh.com/).

Use `pm2 status instantvote` and `pm2 logs instantvote` to check the service.

## API

- In-app reference: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)
- OpenAPI 3.1 specification: [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json)
- Versioned API base path: `/api/v1`

## Tests

```bash
npm run build
npm test
```

## License

[MIT](LICENSE)
