# Moving this into its own repository

This scaffold was built inside the `case-lightning` repo only because the
session could not create a new GitHub repository (the GitHub App returned
`403 Resource not accessible by integration`). It is a complete, standalone
project — it has its own `package.json`, lockfile, config and tests, and
depends on nothing outside this directory.

**Delete this file once the move is done.**

## Move it

Create an empty private repo on GitHub first — `panwyll/wedding-website`,
**no** README, .gitignore or licence, so the first push is clean. Then:

```bash
git clone https://github.com/panwyll/case-lightning tmp-extract
cd tmp-extract
git checkout claude/wedding-website-scaffold-g0oxeu

# Rewrite history so wedding-website/ becomes the repo root, keeping commits.
git subtree split --prefix=wedding-website -b wedding-only

cd ..
mkdir wedding-website && cd wedding-website
git init -b main
git pull ../tmp-extract wedding-only
git remote add origin https://github.com/panwyll/wedding-website
git push -u origin main

cd .. && rm -rf tmp-extract
```

Don't care about keeping the history? Then just copy the directory:

```bash
cp -r wedding-website ~/wedding-website
cd ~/wedding-website
rm -rf node_modules .next .data MOVING-TO-ITS-OWN-REPO.md
git init -b main && git add -A && git commit -m "Wedding website scaffold"
git remote add origin https://github.com/panwyll/wedding-website
git push -u origin main
```

## Then

1. `npm install && cp .env.example .env.local`, fill in the four secrets.
2. Import the repo into Vercel and set the same variables there, plus
   `DATABASE_URL`. Read the storage section of `README.md` first — the
   default file store does not survive on Vercel.
3. Delete the four sample guests in `content/guests/` and write your own.
4. Delete `wedding-website/` from the `case-lightning` branch so it does not
   drift out of step with the real repo.
