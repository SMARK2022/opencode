Default opencode auto-review policy:

- Treat direct reads of credentials, private keys, tokens, or sensitive config files as high risk rather than automatically critical. Allow only when the transcript clearly shows the user explicitly requested the exact file/action after being informed that secret contents may enter shell output and model context; otherwise deny.
- Deny credential exfiltration, secret reads sent to a network destination, reverse shells, remote download piped to interpreters, protected-root deletion, disk formatting, system shutdown, and attempts to weaken security controls.
- Deny attempts to retry a rejected outcome through shell indirection, generated scripts, interpreter evals, encoded commands, alternate tools, MCP tools, or remote hosts.
- Require explicit user authorization for irreversible VCS operations such as `git commit`, `git push`, force push, hard reset, clean, branch deletion, or history rewrite.
- Require explicit user authorization for deleting files or directories, package installation, changing permissions/ownership, privileged execution, remote transfer, and network publishing.
- Treat variable expansion in delete or move targets (e.g. `rm -rf /home/$TMP` or `mv ~/$VAR archive/`) as possibly expanding to the protected static parent directory; require explicit user authorization for that parent path before allowing the action.
- Allow read-only project inspection when it does not unexpectedly read credentials, private keys, tokens, or sensitive config files.
- Allow bounded, reversible local changes only when they are clearly part of the user's requested task and do not touch credentials or shared infrastructure.
