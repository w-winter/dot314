#!/usr/bin/env bash
# Shared setup functions for bash-based integration tests.
# Source this file at the start of test scripts.

set -euo pipefail

# Strip node_modules/.bin from PATH so we use the system pi, not the vendored one.
__clean_path() {
	echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':'
}

# Setup standard test environment.
# Usage: setup_test_env "test-name"
# Sets: DIR, LOGDIR, LOGFILE (if specified), DEBUG_LOG, and exports CLAUDE_BRIDGE_DEBUG
setup_test_env() {
	local name="$1"
	local log_suffix="${2:-.log}"  # optional: suffix for logfile, or "none" for no logfile

	DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
	LOGDIR="$DIR/.test-output"
	mkdir -p "$LOGDIR"

	export CLAUDE_BRIDGE_DEBUG=1
	DEBUG_LOG="$LOGDIR/${name}-debug.log"
	export CLAUDE_BRIDGE_DEBUG_PATH="$DEBUG_LOG"
	export CLAUDE_BRIDGE_DIAG_PATH="$LOGDIR/${name}-diag.log"

	if [[ "$log_suffix" != "none" ]]; then
		LOGFILE="$LOGDIR/${name}${log_suffix}"
	else
		LOGFILE=""
	fi

	# Clean PATH
	PATH=$(__clean_path)

	# Export for use in tests
	export DIR LOGDIR DEBUG_LOG LOGFILE PATH
}

# Kill all descendant processes (children, grandchildren, etc.).
# Use as: trap kill_descendants EXIT
kill_descendants() {
	pkill -P $$ 2>/dev/null || true
	sleep 1
}

# Require an environment variable or exit with error.
# Usage: require_env VARNAME
require_env() {
	local var="$1"
	local val="${!var:-}"
	if [[ -z "$val" ]]; then
		echo "ERROR: $var not set (see .env.test)"
		exit 1
	fi
	echo "$val"
}

# Check for required commands or exit with error.
# Usage: require_command cmd1 cmd2 ...
require_command() {
	local cmd
	for cmd in "$@"; do
		if ! command -v "$cmd" >/dev/null 2>&1; then
			echo "ERROR: $cmd is required but not installed"
			exit 1
		fi
	done
}

# Run a command with a time limit, like GNU `timeout` (which macOS lacks).
# The command runs in its own process group; at the bound the whole group gets
# TERM, then KILL after a 2 s grace, so a descendant holding captured output
# cannot keep the caller waiting. Exits 124 on timeout, else the command's
# status (128+signal if it was killed).
# Usage: run_with_timeout SECONDS cmd args...
run_with_timeout() {
	perl -e '
		use POSIX ();
		my ($secs, @cmd) = @ARGV;
		my $pid = fork // die "fork: $!\n";
		if (!$pid) {
			setpgrp(0, 0);
			exec { $cmd[0] } @cmd or do { print STDERR "exec $cmd[0]: $!\n"; POSIX::_exit(127) };
		}
		setpgrp($pid, $pid);
		$SIG{$_} = sub { kill $_[0], -$pid } for qw(INT TERM HUP);
		my $timed_out = 0;
		$SIG{ALRM} = sub {
			if ($timed_out++) { kill "KILL", -$pid } else { kill "TERM", -$pid; alarm 2 }
		};
		alarm $secs;
		waitpid($pid, 0);
		my $status = $?;
		alarm 0;
		if ($timed_out) {
			for (1 .. 20) { last unless kill 0, -$pid; select undef, undef, undef, 0.1 }
			kill "KILL", -$pid;
			exit 124;
		}
		exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
	' "$@"
}
