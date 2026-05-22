Default opencode auto-review policy:

- Deny direct reads of credentials, private keys, tokens, or sensitive config files, credential exfiltration, secret reads sent to a network destination, reverse shells, remote download piped to interpreters, protected-root deletion, disk formatting, system shutdown, and attempts to weaken security controls.
- Deny attempts to retry a rejected outcome through shell indirection, generated scripts, interpreter evals, encoded commands, alternate tools, MCP tools, or remote hosts.
- Require explicit user authorization for irreversible VCS operations such as `git commit`, `git push`, force push, hard reset, clean, branch deletion, or history rewrite.
- Require explicit user authorization for deleting files or directories, package installation, changing permissions/ownership, privileged execution, remote transfer, and network publishing.
- Allow read-only project inspection when it does not read credentials, private keys, tokens, or sensitive config files.
- Allow bounded, reversible local changes only when they are clearly part of the user's requested task and do not touch credentials or shared infrastructure.
