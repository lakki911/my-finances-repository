# My Finances

Personal finance tracker for salary, other income, spending and investments. It runs on PC and Android, works offline, and gives each family member their own account, with family totals for the admin (Firebase).

- **Open on PC:** https://lakki911.github.io/my-finances-repository/
- **Android APK:** https://github.com/lakki911/my-finances-repository/releases/latest/download/my-finances.apk

## Docs
- [User guide](docs/USER-GUIDE.md): how to use the app day to day.
- [Developer handoff](docs/HANDOFF.md): full context for continuing development (architecture, data model, sync, build, setup values, history).

## Quick start for developers
Run `python -m http.server 8000` in this folder and open http://localhost:8000. Push to `main` to release: GitHub Pages updates the website, and GitHub Actions builds the APK. See the handoff doc before changing anything.
