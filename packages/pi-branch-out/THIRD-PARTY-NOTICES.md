# Third-Party Notices

## davidgasquez/dotfiles

- **URL:** https://github.com/davidgasquez/dotfiles
- **License:** MIT
- **Copyright:** © 2016 David Gasquez

`extensions/branch-out/index.ts` began as an iteration on [`branch-term.ts`](https://github.com/davidgasquez/dotfiles/blob/main/agents/pi/extensions/branch-term.ts).  The original provides `/branch` with session forking into a new Alacritty window.  This version extends it with backend-aware routing (cmux, tmux, iTerm2, Terminal.app, Ghostty), config-driven split/tab launch mode, static and rotating layout policies, split-direction fallback lists, `preserveFocus` behavior, and optional model and message queuing for the child session; see README for details.
