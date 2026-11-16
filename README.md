# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/WsNodeX/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/WsNodeX/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, written from scratch with no git binary: smart HTTP protocol (upload-pack v2 fetch with shallow/deepen support, receive-pack v0 push with fast-forward checks), a REST v3 subset (repos, contents, issues, pulls with squash merge), a GraphQL subset with its own parser and executor, and an MCP server (modern discover + legacy initialize). One in-memory store with a canonical-owner model and a logical clock backs all four faces, so git, REST, GraphQL and MCP always agree.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=5x37k9kh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
