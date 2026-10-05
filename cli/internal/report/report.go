// Package report turns a CI job's step timings into a ReportBuild request.
package report

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// Step mirrors buildinsights.v1.Step in Connect's JSON encoding.
type Step struct {
	Name       string    `json:"name"`
	StartedAt  time.Time `json:"startedAt"`
	DurationMs uint32    `json:"durationMs"`
	Cached     bool      `json:"cached,omitempty"`
	ExitCode   int32     `json:"exitCode,omitempty"`
}

type Request struct {
	ProjectID string `json:"projectId"`
	BuildID   string `json:"buildId"`
	GitRef    string `json:"gitRef,omitempty"`
	Steps     []Step `json:"steps"`
}

type Response struct {
	AcceptedSteps uint32 `json:"acceptedSteps"`
	Replaced      bool   `json:"replaced"`
}

// ReadSteps parses a JSON array of steps and checks what can be checked locally,
// so obvious mistakes fail before anything is sent.
func ReadSteps(r io.Reader) ([]Step, error) {
	decoder := json.NewDecoder(r)
	decoder.DisallowUnknownFields()
	var steps []Step
	if err := decoder.Decode(&steps); err != nil {
		return nil, fmt.Errorf("steps file: %w", err)
	}
	var problems []string
	if len(steps) == 0 {
		problems = append(problems, "no steps")
	}
	for i, s := range steps {
		if strings.TrimSpace(s.Name) == "" {
			problems = append(problems, fmt.Sprintf("step %d has no name", i))
		}
		if s.StartedAt.IsZero() {
			problems = append(problems, fmt.Sprintf("step %d (%s) has no startedAt", i, s.Name))
		}
	}
	if len(problems) > 0 {
		return nil, errors.New("steps file: " + strings.Join(problems, "; "))
	}
	return steps, nil
}

// Env reads CI defaults; GitHub Actions variables are used when present.
type Env func(string) string

// BuildID defaults to the CI run id plus attempt, so a re-run is a new build but a retried upload is not.
func BuildID(explicit string, env Env) string {
	if explicit != "" {
		return explicit
	}
	if run := env("GITHUB_RUN_ID"); run != "" {
		attempt := env("GITHUB_RUN_ATTEMPT")
		if attempt == "" {
			attempt = "1"
		}
		return "gh-" + run + "-" + attempt
	}
	return ""
}

func GitRef(explicit string, env Env) string {
	if explicit != "" {
		return explicit
	}
	return env("GITHUB_REF_NAME")
}
