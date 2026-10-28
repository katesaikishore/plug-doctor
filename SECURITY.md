# Security

Plug Doctor runs commands with administrator rights on people's computers, so we take security reports seriously.

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the Security tab, not in a public issue. Include the steps to reproduce and the OS.

Especially in scope:

- Any way for a USB device, its descriptor strings, a knowledge base file or assistant output to make Plug Doctor run a command that is not on the allow-list in `src/core/fix/runner.js`, or to run one without approval
- Script injection into the renderer
- Leaks of the stored API key
