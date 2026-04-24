import chalk from "chalk";

export const Severity = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info"
};

const icon = {
  critical: "🚨",
  high: "⚠️ ",
  medium: "🔶",
  low: "🔹",
  info: "ℹ️ "
};

const color = {
  critical: chalk.red.bold,
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.cyan,
  info: chalk.gray
};

export class Reporter {
  constructor(opts = {}) {
    this.json = opts.json || false;
    this.issues = [];
  }

  report(issues) {
    this.issues = issues;
    if (this.json) {
      console.log(JSON.stringify({
        summary: this.summary(),
        issues
      }, null, 2));
      return;
    }
    this.printHuman(issues);
  }

  printHuman(issues) {
    console.log(chalk.bold("\n🔍 safeship 보안 검사 결과\n"));

    if (issues.length === 0) {
      console.log(chalk.green("✅ 발견된 이슈 없음\n"));
      return;
    }

    const grouped = {};
    for (const issue of issues) {
      grouped[issue.severity] = grouped[issue.severity] || [];
      grouped[issue.severity].push(issue);
    }

    for (const sev of ["critical", "high", "medium", "low", "info"]) {
      const group = grouped[sev];
      if (!group) continue;
      console.log(color[sev](`${icon[sev]} ${sev.toUpperCase()} (${group.length}건)`));
      for (const issue of group) {
        const scope = issue.scope ? chalk.gray(`[${issue.scope}] `) : "";
        console.log(`  ${color[sev]("●")} ${scope}${issue.title}`);
        if (issue.location) console.log(chalk.gray(`    위치: ${issue.location}`));
        if (issue.detail) console.log(chalk.gray(`    ${issue.detail}`));
        if (issue.hint) console.log(chalk.gray(`    👉 ${issue.hint}`));
      }
      console.log();
    }

    const s = this.summary();
    console.log(chalk.bold("─".repeat(50)));
    console.log(chalk.bold("요약:"));
    console.log(
      `  ${chalk.red.bold(`Critical: ${s.critical}`)}  ` +
      `${chalk.red(`High: ${s.high}`)}  ` +
      `${chalk.yellow(`Medium: ${s.medium}`)}  ` +
      `${chalk.cyan(`Low: ${s.low}`)}  ` +
      `${chalk.gray(`Info: ${s.info}`)}`
    );

    if (this.hasCritical()) {
      console.log(chalk.red.bold("\n❌ 배포 차단 권장 (Critical/High 이슈 존재)"));
    } else if (s.medium > 0) {
      console.log(chalk.yellow("\n⚠️  검토 권장 (Medium 이슈 존재)"));
    } else {
      console.log(chalk.green("\n✅ 배포 가능"));
    }
    console.log();
  }

  summary() {
    const s = {
      critical: 0, high: 0, medium: 0, low: 0, info: 0,
      total: this.issues.length
    };
    for (const issue of this.issues) s[issue.severity]++;
    return s;
  }

  hasCritical() {
    return this.issues.some(
      i => i.severity === "critical" || i.severity === "high"
    );
  }
}
