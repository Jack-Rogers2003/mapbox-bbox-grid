# Publishing mapbox-bbox-grid to npm (with pnpm)

## A. One-time setup
1. **npm account.** Sign up at https://www.npmjs.com/signup and enable 2FA (required to publish).
2. **Install pnpm.** `corepack enable` (ships with Node) makes the `pnpm` version pinned in package.json
   available. Or `npm install -g pnpm`.
3. **Pick a name.** `pnpm view mapbox-bbox-grid`: an E404 error means it is free. If taken, use a scoped name,
   e.g. `@your-npm-username/mapbox-bbox-grid` (edit `name` in package.json).
4. **Fill in your details** in package.json (author, repository, homepage, bugs) and LICENSE.
5. **Create the GitHub repo and push.**
   `git init && git add . && git commit -m "Initial release" && git branch -M main`
   `git remote add origin git@github.com:YOUR-USER/mapbox-bbox-grid.git && git push -u origin main`

## B. Verify locally (do this before every release)
6. `pnpm install` creates `pnpm-lock.yaml`. Commit it (CI uses `--frozen-lockfile`).
7. `pnpm lint:fix` once, to let Biome format and sort imports. Commit the result.
8. `pnpm check` (typecheck + lint + JSDoc check + tests) must pass. Then `pnpm build`.
9. `pnpm pack` creates `mapbox-bbox-grid-0.1.0.tgz`; `tar -tzf mapbox-bbox-grid-0.1.0.tgz` should list only
   `package/dist/*`, README.md, LICENSE and package.json.
10. In a scratch project: `pnpm add /path/to/mapbox-bbox-grid-0.1.0.tgz`, import it, and draw a grid on a real
    Mapbox map (use your public `pk.` token).

## C. First release (by hand)
11. `pnpm login`
12. `pnpm publish --access public` (runs `prepublishOnly`, so check + build run again; enter your 2FA code).
    pnpm refuses to publish from a dirty tree or a branch other than main; commit first.
13. Verify: `pnpm view mapbox-bbox-grid`, then `pnpm add mapbox-bbox-grid` in an empty folder.
14. `git tag v0.1.0 && git push --tags`

## D. Later releases (automated)
15. One-time: on npmjs.com create a **granular access token** with read+write on this package. In the GitHub repo
    go to Settings > Secrets and variables > Actions and add it as `NPM_TOKEN`.
16. To release: bump the version (edit package.json, or `npm version patch`, which works fine in a pnpm project),
    then `git push && git push --tags`.
17. On GitHub: Releases > Draft a new release > choose the tag > Publish.
    `.github/workflows/publish.yml` runs check + build and `pnpm publish --provenance`.
    `.github/workflows/ci.yml` also runs the checks on every push and pull request.

## Rules to remember
- A version number can never be republished, even after unpublishing. Fix forward with a new version.
- Semver: patch = bug fix, minor = new feature, major = breaking change.
- Never commit your npm token. Only dist/, README and LICENSE ship (see "files" in package.json).
