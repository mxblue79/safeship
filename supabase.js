import { createClient } from "@supabase/supabase-js";

/**
 * Supabase 런타임 보안 검증
 *
 * 1. anon 키로 각 테이블 SELECT/INSERT 시도 → RLS 기본 방어 확인
 * 2. (선택) 두 테넌트 사용자 토큰으로 상호 접근 시도 → 멀티테넌트 격리 검증
 */
export async function runSupabaseChecks(config = {}) {
  const issues = [];

  if (!config.url || !config.anonKey) {
    issues.push({
      severity: "info",
      title: "Supabase 검사 설정 누락",
      hint: "safeship.config.yaml의 supabase.url, supabase.anonKey 설정 필요"
    });
    return issues;
  }

  const tables = config.tables || [];
  if (tables.length === 0) {
    issues.push({
      severity: "info",
      title: "검사할 테이블 목록이 비어 있음",
      hint: "safeship.config.yaml의 supabase.tables에 테이블명 추가"
    });
    return issues;
  }

  // 1. anon 접근 테스트
  await runAnonProbe(config, tables, issues);

  // 2. 멀티테넌트 격리 테스트
  if (config.tenantTest?.enabled) {
    await runTenantIsolation(config, issues);
  }

  return issues;
}

async function runAnonProbe(config, tables, issues) {
  const anon = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  for (const table of tables) {
    // SELECT 시도
    try {
      const { data, error } = await anon.from(table).select("*").limit(1);

      if (error) {
        // permission denied / RLS 차단 등
        if (/permission denied|not allowed|violat/i.test(error.message)) {
          // 정상적으로 차단됨 → 이슈 없음
        } else {
          issues.push({
            severity: "low",
            title: `[${table}] SELECT 에러 (RLS 외 원인 가능)`,
            detail: error.message,
            hint: "테이블 존재 여부, 스키마 확인"
          });
        }
      } else if (data && data.length > 0) {
        issues.push({
          severity: "critical",
          title: `[${table}] anon 키로 SELECT 성공 (데이터 노출)`,
          detail: `${data.length}건 이상 조회됨`,
          hint: "RLS 활성화 + SELECT 정책 재검토"
        });
      } else {
        // 에러 없고 빈 결과 → 정책이 0건 리턴 or 빈 테이블
        issues.push({
          severity: "low",
          title: `[${table}] SELECT는 통과, 결과 0건`,
          hint: "실제 데이터가 있는 상태에서 재검증 필요 (빈 테이블일 수도 있음)"
        });
      }
    } catch (e) {
      issues.push({
        severity: "info",
        title: `[${table}] SELECT 테스트 중 예외`,
        detail: e.message
      });
    }

    // INSERT 시도 (dummy 데이터)
    const dummyId = crypto.randomUUID();
    try {
      const { error: insertErr } = await anon
        .from(table)
        .insert({ id: dummyId });

      if (!insertErr) {
        issues.push({
          severity: "critical",
          title: `[${table}] anon 키로 INSERT 성공`,
          hint: "INSERT 정책에 WITH CHECK 추가 또는 anon INSERT 차단"
        });

        // rollback 시도 (실패해도 무시)
        await anon.from(table).delete().eq("id", dummyId);
      }
    } catch {
      // INSERT 실패 = 정상
    }
  }
}

async function runTenantIsolation(config, issues) {
  const { tenantTest } = config;
  const {
    userAToken, userBToken,
    userATenantId, userBTenantId,
    tenantTables = []
  } = tenantTest;

  if (!userAToken || !userBToken || !userBTenantId || tenantTables.length === 0) {
    issues.push({
      severity: "info",
      title: "멀티테넌트 테스트 설정 불완전",
      hint: "tenantTest.userAToken, userBToken, userBTenantId, tenantTables 모두 필요"
    });
    return;
  }

  const clientA = createClient(config.url, config.anonKey, {
    global: { headers: { Authorization: `Bearer ${userAToken}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  for (const table of tenantTables) {
    // 시나리오 1: User A 가 B 의 데이터 SELECT
    try {
      const { data } = await clientA
        .from(table)
        .select("*")
        .eq("tenant_id", userBTenantId);

      if (data && data.length > 0) {
        issues.push({
          severity: "critical",
          title: `[${table}] 테넌트 격리 실패: User A가 User B의 데이터 SELECT 가능`,
          detail: `${data.length}건 노출`,
          hint: "USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid) 정책 적용"
        });
      }
    } catch {}

    // 시나리오 2: User A 가 B 의 tenant 로 INSERT
    try {
      const { error } = await clientA.from(table).insert({
        tenant_id: userBTenantId,
        created_at: new Date().toISOString()
      });
      if (!error) {
        issues.push({
          severity: "critical",
          title: `[${table}] 테넌트 격리 실패: User A가 User B의 tenant에 INSERT 가능`,
          hint: "WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid) 추가"
        });
      }
    } catch {}

    // 시나리오 3: User A 가 B 의 데이터 UPDATE
    try {
      const { data: updated } = await clientA
        .from(table)
        .update({ _safeship_probe: new Date().toISOString() })
        .eq("tenant_id", userBTenantId)
        .select();

      if (updated && updated.length > 0) {
        issues.push({
          severity: "critical",
          title: `[${table}] 테넌트 격리 실패: User A가 User B의 데이터 UPDATE 가능`,
          detail: `${updated.length}건 수정됨`,
          hint: "UPDATE 정책의 USING + WITH CHECK 둘 다 점검"
        });
      }
    } catch {}

    // 시나리오 4: User A 가 B 의 데이터 DELETE (읽기 전용 조회로 대체 권장)
    // 실제 DELETE는 파괴적이므로 UPDATE 결과를 보고 추론
  }
}
