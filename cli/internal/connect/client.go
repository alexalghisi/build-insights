// Package connect is a minimal client for unary Connect RPCs over HTTP with JSON.
// The Connect protocol is plain HTTP POST, so the CLI needs no generated code.
package connect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
)

// Error is a Connect error returned by the server.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"-"`
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Retryable reports whether calling again may succeed. Only safe for idempotent RPCs.
func (e *Error) Retryable() bool {
	switch e.Code {
	case "unavailable", "resource_exhausted", "deadline_exceeded":
		return true
	}
	return false
}

type Client struct {
	BaseURL     string
	Token       string
	HTTP        *http.Client
	MaxAttempts int
	BaseDelay   time.Duration
	// Sleep is replaceable so tests don't wait.
	Sleep func(context.Context, time.Duration) error
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL:     strings.TrimRight(baseURL, "/"),
		Token:       token,
		HTTP:        &http.Client{Timeout: 30 * time.Second},
		MaxAttempts: 4,
		BaseDelay:   250 * time.Millisecond,
		Sleep:       sleep,
	}
}

// Call invokes procedure (for example "buildinsights.v1.IngestService/ReportBuild"),
// retrying transient failures with exponential backoff and jitter.
func (c *Client) Call(ctx context.Context, procedure string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encoding request: %w", err)
	}
	var last error
	for attempt := 1; attempt <= c.MaxAttempts; attempt++ {
		last = c.once(ctx, procedure, body, response)
		var connectErr *Error
		retryable := errors.As(last, &connectErr) && connectErr.Retryable() || isNetworkError(last)
		if last == nil || !retryable || attempt == c.MaxAttempts {
			return last
		}
		delay := c.BaseDelay << (attempt - 1)
		delay += time.Duration(rand.Int64N(int64(delay)/2 + 1))
		if err := c.Sleep(ctx, delay); err != nil {
			return err
		}
	}
	return last
}

type networkError struct{ err error }

func (n networkError) Error() string { return n.err.Error() }
func (n networkError) Unwrap() error { return n.err }

func isNetworkError(err error) bool {
	var n networkError
	return errors.As(err, &n)
}

func (c *Client) once(ctx context.Context, procedure string, body []byte, response any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/"+procedure, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return networkError{fmt.Errorf("calling %s: %w", procedure, err)}
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return networkError{fmt.Errorf("reading response: %w", err)}
	}
	if res.StatusCode != http.StatusOK {
		connectErr := &Error{Status: res.StatusCode}
		if json.Unmarshal(payload, connectErr) != nil || connectErr.Code == "" {
			connectErr.Code = codeForStatus(res.StatusCode)
			connectErr.Message = strings.TrimSpace(string(payload))
		}
		return connectErr
	}
	if err := json.Unmarshal(payload, response); err != nil {
		return fmt.Errorf("decoding response: %w", err)
	}
	return nil
}

// codeForStatus maps HTTP statuses from proxies and load balancers, which don't speak Connect.
func codeForStatus(status int) string {
	switch status {
	case http.StatusTooManyRequests:
		return "resource_exhausted"
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return "unavailable"
	case http.StatusUnauthorized:
		return "unauthenticated"
	case http.StatusForbidden:
		return "permission_denied"
	case http.StatusNotFound:
		return "unimplemented"
	}
	return "unknown"
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
