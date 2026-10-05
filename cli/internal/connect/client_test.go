package connect

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func noSleep(context.Context, time.Duration) error { return nil }

func newTestClient(url string) *Client {
	c := New(url, "bi_secret")
	c.Sleep = noSleep
	return c
}

func TestCallSendsConnectRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pkg.Service/Method" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer bi_secret" {
			t.Errorf("authorization = %q", got)
		}
		if got := r.Header.Get("Connect-Protocol-Version"); got != "1" {
			t.Errorf("protocol version = %q", got)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]string{"echo": body["say"]})
	}))
	defer server.Close()

	var out struct{ Echo string }
	if err := newTestClient(server.URL).Call(context.Background(), "pkg.Service/Method", map[string]string{"say": "hi"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Echo != "hi" {
		t.Fatalf("echo = %q", out.Echo)
	}
}

func TestCallRetriesTransientErrors(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			w.WriteHeader(http.StatusServiceUnavailable) // a proxy, not Connect
		case 2:
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"code":"resource_exhausted","message":"slow down"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer server.Close()

	if err := newTestClient(server.URL).Call(context.Background(), "p/M", struct{}{}, &struct{}{}); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestCallDoesNotRetryClientErrors(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"permission_denied","message":"This token doesn't have the builds:write scope"}`))
	}))
	defer server.Close()

	err := newTestClient(server.URL).Call(context.Background(), "p/M", struct{}{}, &struct{}{})
	var connectErr *Error
	if !errors.As(err, &connectErr) || connectErr.Code != "permission_denied" {
		t.Fatalf("err = %v", err)
	}
	if err.Error() != "permission_denied: This token doesn't have the builds:write scope" {
		t.Fatalf("message = %q", err.Error())
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
}

func TestCallGivesUpAfterMaxAttempts(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	err := newTestClient(server.URL).Call(context.Background(), "p/M", struct{}{}, &struct{}{})
	var connectErr *Error
	if !errors.As(err, &connectErr) || connectErr.Code != "unavailable" {
		t.Fatalf("err = %v", err)
	}
	if calls != 4 {
		t.Fatalf("calls = %d, want 4", calls)
	}
}

func TestCallRetriesNetworkErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close() // nothing listens any more

	client := newTestClient(url)
	attempts := 0
	client.Sleep = func(context.Context, time.Duration) error { attempts++; return nil }
	if err := client.Call(context.Background(), "p/M", struct{}{}, &struct{}{}); err == nil {
		t.Fatal("expected an error")
	}
	if attempts != 3 {
		t.Fatalf("backoffs = %d, want 3", attempts)
	}
}
