# Linux test environment for the Qwen secretary experiment (see README.md).
# Build from the repository root:
#   docker build -f experiments/qwen-secretary/Dockerfile -t pi-team-experiment .
FROM node:24-bookworm
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git python3 python3-pytest ca-certificates curl procps \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.0
WORKDIR /pkg
COPY package.json package-lock.json ./
# Installs the Linux prebuilt PTY binary (@lydell/node-pty-linux-*); nothing is compiled.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY db ./db
COPY contracts ./contracts
COPY experiments/qwen-secretary ./experiments/qwen-secretary
RUN git config --global user.email "experiment@example.invalid" && git config --global user.name "experiment"
ENV PI_TEAM_STATE_DIR=/state PI_CODING_AGENT_DIR=/pi-agent TERM=xterm-256color
CMD ["node", "--disable-warning=ExperimentalWarning", "/pkg/experiments/qwen-secretary/driver.ts"]
