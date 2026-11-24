# Hatchlight

An open source project that takes contributions from the community.

## Language

Everything that goes into the repository is written in English, whatever
language the conversation is in:

- code: identifiers, comments, string literals, error messages and UI text;
- tests: names and descriptions;
- documentation, commit messages, pull requests and issues.

## Checks

Run all three before calling a change done:

```sh
bun test && bun run typecheck && bun run lint
```

`bun run format` fixes formatting and import order.

## Translations

Every text a person reads in the app or on the site comes from a catalog, never
from code:

- `apps/web/src/locales/` for the app, `apps/site/src/locales/` for the site,
  one JSON file per language.
- The command line (`packages/cli`) and agent tools speak English only, like
  other developer tools; they have no catalog.
- English (`en.json`) is the source and has every key. Other languages may lag
  behind: a missing key falls back to English.
- When you add or change an English message, update the other languages you
  can. A translation must use the same `{placeholders}` as English; the tests
  check it.
- Format numbers, sizes, money and dates with the translator (`number`,
  `bytes`, `date`), never by hand.
