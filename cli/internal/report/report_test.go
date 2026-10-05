package report

import (
	"strings"
	"testing"
	"time"
)

func TestReadSteps(t *testing.T) {
	steps, err := ReadSteps(strings.NewReader(`[
		{"name": "install", "startedAt": "2026-10-05T10:00:00Z", "durationMs": 3100, "cached": true},
		{"name": "test", "startedAt": "2026-10-05T10:00:03.100Z", "durationMs": 45000}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || !steps[0].Cached || steps[1].DurationMs != 45000 {
		t.Fatalf("steps = %+v", steps)
	}
	if want := time.Date(2026, 10, 5, 10, 0, 3, 100_000_000, time.UTC); !steps[1].StartedAt.Equal(want) {
		t.Fatalf("startedAt = %v", steps[1].StartedAt)
	}
}

func TestReadStepsReportsEveryProblem(t *testing.T) {
	_, err := ReadSteps(strings.NewReader(`[{"name": "", "durationMs": 1}, {"name": "lint", "durationMs": 2}]`))
	want := "steps file: step 0 has no name; step 0 () has no startedAt; step 1 (lint) has no startedAt"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v", err)
	}
}

func TestReadStepsRejectsTypos(t *testing.T) {
	if _, err := ReadSteps(strings.NewReader(`[{"name": "x", "startedAt": "2026-10-05T10:00:00Z", "duration_ms": 5}]`)); err == nil {
		t.Fatal("expected unknown field error")
	}
}

func TestDefaultsFromGitHubActions(t *testing.T) {
	env := func(key string) string {
		return map[string]string{"GITHUB_RUN_ID": "9001", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_REF_NAME": "main"}[key]
	}
	if got := BuildID("", env); got != "gh-9001-2" {
		t.Fatalf("build id = %q", got)
	}
	if got := BuildID("custom", env); got != "custom" {
		t.Fatalf("explicit build id ignored: %q", got)
	}
	if got := GitRef("", env); got != "main" {
		t.Fatalf("git ref = %q", got)
	}
	if got := BuildID("", func(string) string { return "" }); got != "" {
		t.Fatalf("build id without CI = %q", got)
	}
}
