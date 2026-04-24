#!/usr/bin/env node
import { Command } from "commander";
import { runStatic } from "./static.js";
import { runSupabaseChecks } from "./supabase.js";
import { runHttpChecks } from "./http.js";
import { Reporter } from "./reporter.js";
import { loadConfig } from "./runner.js";

const program = new Command();

program
  .name("safeship")
  .description("배포 전 보안 검증 도구 - 정적/런타임/설정 3중 검사")
  .version("0.1.0");

program
  .command("static [path]")
  .description("코드베이스 정적 분석 (하드코딩 시크릿, 위험 패턴, RLS SQL 검사)")
  .option("--json", "JSON 출력")
  .action(async (targetPath = ".", opts) => {
    const reporter = new Reporter({ json: opts.json });
    const issues = await runStatic(targetPath);
    reporter.report(issues);
    process.exit(reporter.hasCritical() ? 1 : 0);
  });

program
  .command("supabase")
  .description("Supabase RLS 런타임 검증 + 멀티테넌트 격리 테스트")
  .option("-c, --config <path>", "설정 파일 경로", "safeship.config.yaml")
  .option("--json", "JSON 출력")
  .action(async (opts) => {
    try {
      const config = loadConfig(opts.config);
      const reporter = new Reporter({ json: opts.json });
      const issues = await runSupabaseChecks(config.supabase || {});
      reporter.report(issues);
      process.exit(reporter.hasCritical() ? 1 : 0);
    } catch (e) {
      console.error("오류:", e.message);
      process.exit(2);
    }
  });

program
  .command("http <url>")
  .description("배포된 URL의 보안 헤더와 HTTPS 설정 검증")
  .option("--json", "JSON 출력")
  .action(async (url, opts) => {
    const reporter = new Reporter({ json: opts.json });
    const issues = await runHttpChecks(url);
    reporter.report(issues);
    process.exit(reporter.hasCritical() ? 1 : 0);
  });

program
  .command("all")
  .description("설정 파일 기반 전체 검사 (정적 + Supabase + HTTP)")
  .option("-c, --config <path>", "설정 파일 경로", "safeship.config.yaml")
  .option("--json", "JSON 출력")
  .action(async (opts) => {
    try {
      const config = loadConfig(opts.config, { optional: true });
      const reporter = new Reporter({ json: opts.json });
      const all = [];

      if (config.static?.enabled !== false) {
        const staticIssues = await runStatic(config.static?.path || ".");
        all.push(...staticIssues.map(i => ({ ...i, scope: "static" })));
      }

      if (config.supabase?.enabled) {
        const supabaseIssues = await runSupabaseChecks(config.supabase);
        all.push(...supabaseIssues.map(i => ({ ...i, scope: "supabase" })));
      }

      if (config.http?.enabled && config.http.url) {
        const httpIssues = await runHttpChecks(config.http.url);
        all.push(...httpIssues.map(i => ({ ...i, scope: "http" })));
      }

      reporter.report(all);
      process.exit(reporter.hasCritical() ? 1 : 0);
    } catch (e) {
      console.error("오류:", e.message);
      process.exit(2);
    }
  });

program.parse();
