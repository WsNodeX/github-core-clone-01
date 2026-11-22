# forge

A GitHub-compatible git forge in one Node process.

Written from scratch with no git binary: smart HTTP (upload-pack v2 fetch with
shallow/deepen support, receive-pack v0 push with fast-forward checks), a REST v3
subset (repos, contents, issues, pulls with squash merge), a GraphQL subset with its
own parser and executor, and an MCP server (modern discover + legacy initialize).
One in-memory store with a canonical-owner model and a logical clock backs all four
faces, so git, REST, GraphQL and MCP always agree.

## Run it

```sh
node main.ts
# FORGE_LISTENING 41273
```

The git routes are `/{owner}/{repo}.git/...`, so the owner segment is part of the URL
even though there are no accounts. Create a repo, then clone and push it:

```sh
curl -X POST http://127.0.0.1:41273/api/v3/user/repos \
  -H 'content-type: application/json' -d '{"name":"demo"}'

git clone http://127.0.0.1:41273/local/demo.git
cd demo && echo hi > a.txt && git add . && git commit -m "first"
git push origin HEAD:main
```

Real `git clone` and `git push` work against it, including incremental fast-forward
pushes and cloning back what you pushed.

| Surface | Entry point |
| --- | --- |
| git smart HTTP | `/{owner}/{repo}.git/info/refs`, `/git-upload-pack`, `/git-receive-pack` |
| REST v3 | `/api/v3/...` |
| GraphQL | `/api/graphql` |
| MCP | `/mcp` |

Set `FORGE_TOKEN` to require `Authorization: Bearer <token>` on every route. With it
unset the server is open, which is the right default for `127.0.0.1`.

## Two protocol bugs worth reading

Both were found by pointing a real git client at the server, and both look like the
same symptom: `fatal: the remote end hung up` or `expected 'packfile', received
'acknowledgments'`.

**An empty repository never ended its advertisement.** The receive-pack ref listing
returned one pkt-line and stopped -- no flush packet. git reads the listing until a
flush and then sends its POST; without one it waits, times out, and reports a hang. A
repo with any ref was fine, which is why this only surfaced on the first push to a
fresh repository.

**A client that had said `done` was still sent an acknowledgment round.** In protocol
v2 the `acknowledgments` section is for a client still negotiating haves. A client
that sent `done` is stateless: it reads `packfile` next, and anything else is a
protocol error. The server sent `acknowledgments` unconditionally, so any clone of a
non-empty repository failed.

## What it does not do

There is no persistence: the store is in memory, so the process ending is the data
ending. There is no per-user authentication -- `FORGE_TOKEN` is one shared gate, not
accounts. The pack parser handles what git actually emits rather than every historical
edge case, and there is no garbage collection: objects live as long as the process.

## License

MIT