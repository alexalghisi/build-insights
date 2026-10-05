package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeAPI(t *testing.T, handler func(path string, body map[string]any) (int, string)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		status, response := handler(r.URL.Path, body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(response))
	}))
	t.Cleanup(server.Close)
	return server
}

func envWith(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestReportUploadsStepsWithCIDefaults(t *testing.T) {
	var got map[string]any
	server := fakeAPI(t, func(path string, body map[string]any) (int, string) {
		if path != "/buildinsights.v1.IngestService/ReportBuild" {
			t.Errorf("path = %s", path)
		}
		got = body
		return 200, `{"acceptedSteps": 2}`
	})
	file := filepath.Join(t.TempDir(), "steps.json")
	_ = os.WriteFile(file, []byte(`[{"name":"install","startedAt":"2026-10-05T10:00:00Z","durationMs":3000,"cached":true},{"name":"test","startedAt":"2026-10-05T10:00:03Z","durationMs":45000}]`), 0o600)

	var stdout, stderr bytes.Buffer
	env := envWith(map[string]string{"BUILD_INSIGHTS_URL": server.URL, "BUILD_INSIGHTS_TOKEN": "bi_x", "GITHUB_RUN_ID": "77", "GITHUB_REF_NAME": "main"})
	code := run(context.Background(), []string{"report", "--project", "prj_api", "--file", file}, env, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if got["buildId"] != "gh-77-1" || got["gitRef"] != "main" || got["projectId"] != "prj_api" {
		t.Fatalf("request = %v", got)
	}
	if steps := got["steps"].([]any); len(steps) != 2 {
		t.Fatalf("steps = %v", steps)
	}
	if stdout.String() != "reported build gh-77-1: 2 steps\n" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestReportShowsServerErrors(t *testing.T) {
	server := fakeAPI(t, func(string, map[string]any) (int, string) {
		return 400, `{"code":"invalid_argument","message":"Invalid build report: steps[0].duration_ms: at most 86400000"}`
	})
	file := filepath.Join(t.TempDir(), "steps.json")
	_ = os.WriteFile(file, []byte(`[{"name":"x","startedAt":"2026-10-05T10:00:00Z","durationMs":4000000000}]`), 0o600)

	var stdout, stderr bytes.Buffer
	env := envWith(map[string]string{"BUILD_INSIGHTS_URL": server.URL})
	code := run(context.Background(), []string{"report", "--project", "p", "--build", "b1", "--file", file}, env, &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "invalid_argument: Invalid build report: steps[0].duration_ms") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}

func TestStatsPrintsATable(t *testing.T) {
	server := fakeAPI(t, func(path string, body map[string]any) (int, string) {
		if body["windowDays"] != float64(7) {
			t.Errorf("windowDays = %v", body["windowDays"])
		}
		return 200, `{"builds": 42, "steps": [{"name":"test","runs":42,"p50Ms":45000,"p95Ms":61000,"shareOfTime":0.8},{"name":"install","runs":42,"p50Ms":2100,"p95Ms":58000,"cacheHitRate":0.75,"shareOfTime":0.2}]}`
	})
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"stats", "--project", "prj_api", "--days", "7"}, envWith(map[string]string{"BUILD_INSIGHTS_URL": server.URL}), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	out := stdout.String()
	for _, want := range []string{"42 builds in the last 7 days", "45.0s", "61.0s", "75%", "80%"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestUsageErrors(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"report", "--project", "p"}, envWith(nil), &stdout, &stderr); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if code := run(context.Background(), []string{"deploy"}, envWith(nil), &stdout, &stderr); code != 2 {
		t.Fatalf("exit %d", code)
	}
}
