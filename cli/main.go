// Command bi reports CI build step timings to build-insights and prints where build time goes.
//
//	export BUILD_INSIGHTS_TOKEN=bi_...
//	bi report --project prj_123 --file steps.json
//	bi stats --project prj_123 --days 14
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"text/tabwriter"

	"github.com/alexalghisi/build-insights/cli/internal/connect"
	"github.com/alexalghisi/build-insights/cli/internal/report"
)

const usage = `usage:
  bi report --project ID --file steps.json [--build ID] [--ref REF]
  bi stats  --project ID [--days N]

The API token is read from BUILD_INSIGHTS_TOKEN (never a flag, so it stays out of shell history).
The API address is read from BUILD_INSIGHTS_URL (default http://localhost:8080).`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, env report.Env, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	baseURL := env("BUILD_INSIGHTS_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	client := connect.New(baseURL, env("BUILD_INSIGHTS_TOKEN"))

	var err error
	switch args[0] {
	case "report":
		err = runReport(ctx, client, args[1:], env, stdout)
	case "stats":
		err = runStats(ctx, client, args[1:], stdout)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s\n", args[0], usage)
		return 2
	}
	var usageErr usageError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &usageErr):
		fmt.Fprintf(stderr, "%v\n\n%s\n", err, usage)
		return 2
	default:
		fmt.Fprintln(stderr, "error:", err)
		return 1
	}
}

type usageError struct{ msg string }

func (u usageError) Error() string { return u.msg }

func runReport(ctx context.Context, client *connect.Client, args []string, env report.Env, stdout io.Writer) error {
	flags := flag.NewFlagSet("report", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	project := flags.String("project", "", "project id")
	file := flags.String("file", "", "JSON file with the build's steps")
	build := flags.String("build", "", "build id (default: from GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT)")
	ref := flags.String("ref", "", "git ref (default: GITHUB_REF_NAME)")
	if err := flags.Parse(args); err != nil {
		return usageError{err.Error()}
	}
	buildID := report.BuildID(*build, env)
	if *project == "" || *file == "" || buildID == "" {
		return usageError{"report needs --project, --file and a build id (--build, or GITHUB_RUN_ID in CI)"}
	}
	f, err := os.Open(*file)
	if err != nil {
		return err
	}
	defer f.Close()
	steps, err := report.ReadSteps(f)
	if err != nil {
		return err
	}
	var res report.Response
	req := report.Request{ProjectID: *project, BuildID: buildID, GitRef: report.GitRef(*ref, env), Steps: steps}
	// ReportBuild is idempotent per build id, so retrying a failed upload can't double count.
	if err := client.Call(ctx, "buildinsights.v1.IngestService/ReportBuild", req, &res); err != nil {
		return err
	}
	verb := "reported"
	if res.Replaced {
		verb = "replaced"
	}
	fmt.Fprintf(stdout, "%s build %s: %d steps\n", verb, buildID, res.AcceptedSteps)
	return nil
}

type stepStats struct {
	Name         string  `json:"name"`
	Runs         uint32  `json:"runs"`
	P50Ms        uint32  `json:"p50Ms"`
	P95Ms        uint32  `json:"p95Ms"`
	CacheHitRate float64 `json:"cacheHitRate"`
	ShareOfTime  float64 `json:"shareOfTime"`
}

func runStats(ctx context.Context, client *connect.Client, args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("stats", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	project := flags.String("project", "", "project id")
	days := flags.Uint("days", 14, "days to look back (1-90)")
	if err := flags.Parse(args); err != nil {
		return usageError{err.Error()}
	}
	if *project == "" {
		return usageError{"stats needs --project"}
	}
	var res struct {
		Builds uint32      `json:"builds"`
		Steps  []stepStats `json:"steps"`
	}
	req := map[string]any{"projectId": *project, "windowDays": *days}
	if err := client.Call(ctx, "buildinsights.v1.InsightsService/GetStepStats", req, &res); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "%d builds in the last %d days\n\n", res.Builds, *days)
	w := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', tabwriter.AlignRight)
	fmt.Fprintln(w, "step\truns\tp50\tp95\tcache hits\tshare of time\t")
	for _, s := range res.Steps {
		fmt.Fprintf(w, "%s\t%d\t%s\t%s\t%.0f%%\t%.0f%%\t\n", s.Name, s.Runs, seconds(s.P50Ms), seconds(s.P95Ms), s.CacheHitRate*100, s.ShareOfTime*100)
	}
	return w.Flush()
}

func seconds(ms uint32) string {
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}
