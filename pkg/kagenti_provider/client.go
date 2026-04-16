package kagenti_provider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"strings"
	"time"
)

// AgentInfo describes a kagenti agent discovered via the platform.
type AgentInfo struct {
	Name        string   `json:"name"`
	Namespace   string   `json:"namespace"`
	Description string   `json:"description,omitempty"`
	Framework   string   `json:"framework,omitempty"`
	Tools       []string `json:"tools,omitempty"`
}

// AgentCard is the A2A agent card returned by the /.well-known/agent.json endpoint.
type AgentCard struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	URL          string   `json:"url"`
	Capabilities []string `json:"capabilities,omitempty"`
}

// KagentiClient proxies requests to the kagenti A2A protocol endpoint.
type KagentiClient struct {
	baseURL              string
	directAgentURL       string
	directAgentName      string
	directAgentNamespace string
	httpClient           *http.Client
}

// NewKagentiClient creates a new KagentiClient with the given base URL.
func NewKagentiClient(baseURL string) *KagentiClient {
	return &KagentiClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// NewKagentiClientFromEnv creates a KagentiClient from the KAGENTI_CONTROLLER_URL
// environment variable, falling back to in-cluster auto-detection. Returns nil
// if kagenti is not available.
func NewKagentiClientFromEnv() *KagentiClient {
	if direct := strings.TrimRight(os.Getenv("KAGENTI_AGENT_URL"), "/"); direct != "" {
		return &KagentiClient{
			directAgentURL:       direct,
			directAgentName:      os.Getenv("KAGENTI_AGENT_NAME"),
			directAgentNamespace: os.Getenv("KAGENTI_AGENT_NAMESPACE"),
			httpClient: &http.Client{
				Timeout: 30 * time.Second,
			},
		}
	}

	url := os.Getenv("KAGENTI_CONTROLLER_URL")
	if url == "" {
		// Try auto-detection with a short timeout client
		c := &KagentiClient{httpClient: &http.Client{Timeout: 3 * time.Second}}
		url = c.Detect()
	}
	if url == "" {
		return nil // kagenti not available
	}
	return NewKagentiClient(url)
}

// Status checks whether the kagenti controller is reachable.
func (c *KagentiClient) Status() (bool, error) {
	if c.directAgentURL != "" {
		for _, p := range []string{"/.well-known/agent-card.json", "/.well-known/agent.json", "/health", "/healthz"} {
			resp, err := c.httpClient.Get(c.directAgentURL + p)
			if err != nil {
				continue
			}
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return true, nil
			}
		}
		return false, fmt.Errorf("kagenti direct agent health check failed at %s", c.directAgentURL)
	}

	resp, err := c.httpClient.Get(c.baseURL + "/health")
	if err != nil {
		return false, fmt.Errorf("kagenti health check failed: %w", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300, nil
}

// ListAgents queries the kagenti controller for registered agents.
func (c *KagentiClient) ListAgents() ([]AgentInfo, error) {
	if c.directAgentURL != "" {
		name := c.directAgentName
		namespace := c.directAgentNamespace
		if namespace == "" {
			namespace = "default"
		}

		for _, p := range []string{"/.well-known/agent-card.json", "/.well-known/agent.json"} {
			resp, err := c.httpClient.Get(c.directAgentURL + p)
			if err != nil {
				continue
			}
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				var card AgentCard
				if err := json.NewDecoder(resp.Body).Decode(&card); err == nil && card.Name != "" {
					name = card.Name
				}
			}
			resp.Body.Close()
			if name != "" {
				break
			}
		}

		if name == "" {
			name = "kagenti-agent"
		}

		return []AgentInfo{{
			Name:        name,
			Namespace:   namespace,
			Description: fmt.Sprintf("Direct Kagenti agent (%s)", c.directAgentURL),
			Framework:   "kagenti",
		}}, nil
	}

	// Kagenti backend exposes agents under /api/v1/agents
	resp, err := c.httpClient.Get(c.baseURL + "/api/v1/agents")
	if err != nil {
		return nil, fmt.Errorf("failed to list kagenti agents: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list agents returned %d: %s", resp.StatusCode, string(body))
	}

	// The Kagenti API returns a list envelope: `{"items": [...]}`
	var result struct {
		Items []AgentInfo `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode agent list: %w", err)
	}
	return result.Items, nil
}

// Discover fetches the A2A agent card for the given agent.
func (c *KagentiClient) Discover(namespace, agentName string) (*AgentCard, error) {
	url := fmt.Sprintf("%s/api/a2a/%s/%s/.well-known/agent.json",
		c.baseURL, neturl.PathEscape(namespace), neturl.PathEscape(agentName))
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to discover agent %s/%s: %w", namespace, agentName, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("discover agent %s/%s returned %d: %s", namespace, agentName, resp.StatusCode, string(body))
	}

	var card AgentCard
	if err := json.NewDecoder(resp.Body).Decode(&card); err != nil {
		return nil, fmt.Errorf("failed to decode agent card: %w", err)
	}
	return &card, nil
}

// Invoke sends a message to an agent via the A2A protocol and returns the raw
// response body for streaming consumption.
func (c *KagentiClient) Invoke(ctx context.Context, namespace, agentName, message string, contextID string) (io.ReadCloser, error) {
	if c.directAgentURL != "" {
		payload := map[string]any{"message": message}
		if contextID != "" {
			payload["session_id"] = contextID
		}

		body, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal direct invoke payload: %w", err)
		}

		urls := []string{
			c.directAgentURL + "/api/chat/stream",
			c.directAgentURL + "/chat/stream",
			c.directAgentURL + "/stream",
		}

		var lastErr error
		for _, u := range urls {
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(string(body)))
			if err != nil {
				lastErr = err
				continue
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "text/event-stream")

			resp, err := c.httpClient.Do(req)
			if err != nil {
				lastErr = err
				continue
			}

			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return resp.Body, nil
			}

			errBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("direct invoke returned %d: %s", resp.StatusCode, string(errBody))
		}

		if lastErr == nil {
			lastErr = fmt.Errorf("direct invoke failed: no reachable streaming endpoint")
		}
		return nil, lastErr
	}

	// Kagenti backend uses REST+SSE via FastAPI: POST /api/v1/chat/{namespace}/{name}/stream
	type restPayload struct {
		Message   string `json:"message"`
		SessionID string `json:"session_id,omitempty"`
	}
	rp := restPayload{Message: message, SessionID: contextID}
	payload, err := json.Marshal(rp)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal kagenti request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/chat/%s/%s/stream",
		c.baseURL, neturl.PathEscape(namespace), neturl.PathEscape(agentName))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(payload)))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	httpClient := &http.Client{} // no timeout — let caller cancel via ctx
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kagenti invoke failed: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("kagenti invoke returned %d: %s", resp.StatusCode, string(errBody))
	}

	return resp.Body, nil
}

// buildDetectCandidates constructs the list of candidate URLs for kagenti auto-detection.
// The namespace, service name, port, and protocol are configurable via environment
// variables so non-standard deployments can be discovered automatically.
func buildDetectCandidates() []string {
	namespace := os.Getenv("KAGENTI_NAMESPACE")
	if namespace == "" {
		namespace = "kagenti-system"
	}
	serviceName := os.Getenv("KAGENTI_SERVICE_NAME")
	if serviceName == "" {
		serviceName = "kagenti-backend"
	}
	port := os.Getenv("KAGENTI_SERVICE_PORT")
	if port == "" {
		port = "8000"
	}
	protocol := os.Getenv("KAGENTI_SERVICE_PROTOCOL")
	if protocol == "" {
		protocol = "http"
	}
	return []string{
		fmt.Sprintf("%s://%s.%s.svc:%s", protocol, serviceName, namespace, port),
		fmt.Sprintf("%s://%s.%s.svc.cluster.local:%s", protocol, serviceName, namespace, port),
	}
}

// Detect tries common in-cluster kagenti service URLs and returns the first reachable one.
func (c *KagentiClient) Detect() string {
	return c.DetectWithContext(context.Background())
}

// DetectWithContext tries common in-cluster kagenti service URLs with context support (#5566).
func (c *KagentiClient) DetectWithContext(ctx context.Context) string {
	candidates := buildDetectCandidates()
	for _, url := range candidates {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/health", nil)
		if err != nil {
			continue
		}
		resp, err := c.httpClient.Do(req)
		if err == nil {
			resp.Body.Close()
			return url
		}
	}
	return ""
}
