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

## Tests

```bash
npm run build
npm test
```

## License

[MIT](LICENSE)
