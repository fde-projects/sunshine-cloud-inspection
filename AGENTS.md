# Agent / platform conventions for this monorepo

## Layout
- `apps/<name>/` — independently buildable apps (Dockerfile + .dockerignore each)
- `lingstack/` — Hasura CLI metadata/migrations/overview; git-tracked, never in image
- Root `docker-compose.yml` — only orchestrates `apps/*`; no Postgres/Hasura containers

## Auth (BYO JWT)
- Sign HS256 with `HASURA_JWT_SECRET` on the server only (never `NEXT_PUBLIC_`)
- Browser calls GraphQL with `Authorization: Bearer <jwt>`
- Admin Secret is CLI-only, not for login or browser CRUD
- Claims namespace: `https://hasura.io/jwt/claims`

## Schema
- Only Hasura CLI migrations change production schema
- After schema change: migrate apply → track → suggest relationships → metadata export → refresh `lingstack/hasura/hs-kofdlduv/overview/schema.md`

## Do not
- `hasura init .` or init under `lingstack/` root
- Start PG/Hasura in compose
- Put secrets in committed files or frontend env (`NEXT_PUBLIC_*`)
