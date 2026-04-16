package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// KagentiProvider implements AIProvider and StreamingProvider for Kagenti agents REST API
type KagentiProvider struct {
	baseURL      string
	directAgent  string
	agentName    string
	namespace    string
	chatBasePath string
	client       *http.Client
}

var _ AIProvider = (*KagentiProvider)(nil)
var _ StreamingProvider = (*KagentiProvider)(nil)
var _ HandshakeProvider = (*KagentiProvider)(nil)

// NewKagentiProvider creates a new KagentiProvider connected to the Kagenti HTTP backend.
// It auto-detects the backend URL or falls back to an environment variable.
func NewKagentiProvider() *KagentiProvider {
	client := &http.Client{Timeout: 0}

	if agentURL := strings.TrimRight(os.Getenv("KAGENTI_AGENT_URL"), "/"); agentURL != "" {
		return &KagentiProvider{
			directAgent:  agentURL,
			agentName:    os.Getenv("KAGENTI_AGENT_NAME"),
			namespace:    os.Getenv("KAGENTI_AGENT_NAMESPACE"),
			chatBasePath: "/",
			client:       client,
		}
	}

	baseURL := os.Getenv("KAGENTI_CONTROLLER_URL")
	if baseURL == "" {
		baseURL = detectKagentiControllerURL(client)
	}
	if baseURL == "" {
		baseURL = "http://kagenti-controller.kagenti-system.svc:8083"
	}

	p := &KagentiProvider{
		baseURL:      strings.TrimRight(baseURL, "/"),
		chatBasePath: "/api",
		client:       client,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	p.findDefaultAgent(ctx)

	return p
}

func detectKagentiControllerURL(client *http.Client) string {
	namespace := os.Getenv("KAGENTI_NAMESPACE")
	if namespace == "" {
		namespace = "kagenti-system"
	}
	serviceName := os.Getenv("KAGENTI_SERVICE_NAME")
	if serviceName == "" {
		serviceName = "kagenti-controller"
	}
	port := os.Getenv("KAGENTI_SERVICE_PORT")
	if port == "" {
		port = "8083"
	}
	protocol := os.Getenv("KAGENTI_SERVICE_PROTOCOL")
	if protocol == "" {
		protocol = "http"
	}

	candidates := []string{
		fmt.Sprintf("%s://%s.%s.svc:%s", protocol, serviceName, namespace, port),
		fmt.Sprintf("%s://%s.%s.svc.cluster.local:%s", protocol, serviceName, namespace, port),
		"http://kagenti-backend.kagenti-system.svc:8000",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	healthPaths := []string{"/health", "/healthz", "/api/health"}
	for _, candidate := range candidates {
		base := strings.TrimRight(candidate, "/")
		for _, hp := range healthPaths {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+hp, nil)
			if err != nil {
				continue
			}
			resp, err := client.Do(req)
			if err != nil {
				continue
			}
			resp.Body.Close()
			if resp.StatusCode < 400 {
				return base
			}
		}
	}

	return ""
}

type kagentiAgentInfo struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

func parseAgentList(body []byte) []kagentiAgentInfo {
	agents := make([]kagentiAgentInfo, 0)

	var list []map[string]any
	if err := json.Unmarshal(body, &list); err == nil {
		for _, item := range list {
			name, _ := item["name"].(string)
			namespace, _ := item["namespace"].(string)
			if name != "" {
				agents = append(agents, kagentiAgentInfo{Name: name, Namespace: namespace})
			}
		}
		return agents
	}

	var wrapper struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(body, &wrapper); err == nil {
		for _, item := range wrapper.Items {
			name, _ := item["name"].(string)
			namespace, _ := item["namespace"].(string)
			if name != "" {
				agents = append(agents, kagentiAgentInfo{Name: name, Namespace: namespace})
			}
		}
	}

	return agents
}

func (p *KagentiProvider) tryFindDefaultAgent(ctx context.Context, endpoint string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+endpoint, nil)
	if err != nil {
		return false
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false
	}

	body, _ := io.ReadAll(resp.Body)
	agents := parseAgentList(body)
	if len(agents) == 0 {
		return false
	}

	p.agentName = agents[0].Name
	p.namespace = agents[0].Namespace
	if p.namespace == "" {
		p.namespace = "default"
	}
	p.chatBasePath = strings.TrimSuffix(endpoint, "/agents")
	return true
}

func (p *KagentiProvider) findDefaultAgent(ctx context.Context) {
	if p.baseURL == "" {
		return
	}

	for _, endpoint := range []string{"/api/agents", "/api/v1/agents"} {
		if p.tryFindDefaultAgent(ctx, endpoint) {
			return
		}
	}
}

func (p *KagentiProvider) Name() string {
	return "kagenti"
}

func (p *KagentiProvider) DisplayName() string {
	return "Kagenti (In-Cluster)"
}

func (p *KagentiProvider) Description() string {
	if p.directAgent != "" {
		if p.agentName != "" {
			return fmt.Sprintf("Cluster-native AI Agent (%s/%s @ %s)", p.namespace, p.agentName, p.directAgent)
		}
		return fmt.Sprintf("Cluster-native AI Agent (%s)", p.directAgent)
	}
	if p.agentName != "" {
		return fmt.Sprintf("Cluster-native AI Agent (%s/%s)", p.namespace, p.agentName)
	}
	return "Cluster-native AI Agent"
}

func (p *KagentiProvider) Provider() string {
	return "kagenti"
}

func (p *KagentiProvider) IsAvailable() bool {
	if p.directAgent != "" {
		return true
	}
	if p.baseURL == "" {
		return false
	}

	if p.agentName != "" || p.namespace != "" {
		return true
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	return p.controllerReachable(ctx)
}

func (p *KagentiProvider) Capabilities() ProviderCapability {
	return CapabilityChat | CapabilityToolExec
}

func (p *KagentiProvider) Handshake(ctx context.Context) *HandshakeResult {
	if p.directAgent != "" {
		for _, cardPath := range []string{"/.well-known/agent-card.json", "/.well-known/agent.json"} {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.directAgent+cardPath, nil)
			if err != nil {
				continue
			}
			resp, err := p.client.Do(req)
			if err != nil {
				continue
			}
			if resp.StatusCode != http.StatusOK {
				resp.Body.Close()
				continue
			}

			var card struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&card)
			resp.Body.Close()
			if card.Name != "" {
				p.agentName = card.Name
			}

			return &HandshakeResult{
				Ready:   true,
				State:   "connected",
				Message: fmt.Sprintf("Connected to Kagenti agent at %s", p.directAgent),
			}
		}

		return &HandshakeResult{
			Ready:   false,
			State:   "failed",
			Message: fmt.Sprintf("Cannot fetch agent card from %s", p.directAgent),
		}
	}

	if p.baseURL == "" {
		return &HandshakeResult{
			Ready:   false,
			State:   "failed",
			Message: "Kagenti controller URL is not configured. Set KAGENTI_CONTROLLER_URL or KAGENTI_AGENT_URL.",
		}
	}

	if !p.controllerReachable(ctx) {
		return &HandshakeResult{
			Ready:   false,
			State:   "failed",
			Message: fmt.Sprintf("Cannot reach Kagenti controller at %s", p.baseURL),
		}
	}

	if p.agentName == "" {
		p.findDefaultAgent(ctx)
		if p.agentName == "" {
			return &HandshakeResult{
				Ready:   false,
				State:   "connected",
				Message: "Kagenti controller is reachable but no agents were found in the cluster.",
			}
		}
	}

	return &HandshakeResult{
		Ready:   true,
		State:   "connected",
		Message: fmt.Sprintf("Connected to Kagenti controller. Selected agent: %s/%s", p.namespace, p.agentName),
	}
}

// ChatRequestPayload defines what /api/chat/{ns}/{name}/stream expects
type ChatRequestPayload struct {
	Message   string `json:"message"`
	SessionID string `json:"session_id,omitempty"`
}

func (p *KagentiProvider) StreamChat(ctx context.Context, req *ChatRequest, onChunk func(chunk string)) (*ChatResponse, error) {
	return p.StreamChatWithProgress(ctx, req, onChunk, nil)
}

func (p *KagentiProvider) StreamChatWithProgress(ctx context.Context, req *ChatRequest, onChunk func(chunk string), onProgress func(event StreamEvent)) (*ChatResponse, error) {
	if p.agentName == "" {
		p.findDefaultAgent(ctx)
		if p.agentName == "" {
			return nil, fmt.Errorf("no kagenti agent is available")
		}
	}
	if p.namespace == "" {
		p.namespace = "default"
	}

	payload := ChatRequestPayload{
		Message:   req.Prompt,
		SessionID: req.SessionID,
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal kagenti request: %w", err)
	}

	urls := p.streamCandidateURLs()
	if len(urls) == 0 {
		return nil, fmt.Errorf("no kagenti endpoint is configured")
	}

	var resp *http.Response
	var invokeErr error
	for _, url := range urls {
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyBytes))
		if err != nil {
			invokeErr = fmt.Errorf("failed to create request: %w", err)
			continue
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Accept", "text/event-stream")

		resp, err = p.client.Do(httpReq)
		if err != nil {
			invokeErr = fmt.Errorf("failed to invoke kagenti backend at %s: %w", url, err)
			continue
		}

		if resp.StatusCode == http.StatusOK {
			invokeErr = nil
			break
		}

		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		invokeErr = fmt.Errorf("kagenti endpoint %s responded with status %d: %s", url, resp.StatusCode, string(b))
		resp = nil
	}

	if invokeErr != nil {
		return nil, invokeErr
	}
	if resp == nil {
		return nil, fmt.Errorf("kagenti backend did not return a valid stream response")
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	var fullContent strings.Builder

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				break
			}
			return nil, fmt.Errorf("error reading kagenti stream: %w", err)
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				break
			}

			var eventObj map[string]any
			if jsonErr := json.Unmarshal([]byte(data), &eventObj); jsonErr == nil {
				if t, ok := eventObj["type"].(string); ok && t != "" {
					if t == "text" || t == "message_delta" {
						if content, ok := eventObj["text"].(string); ok {
							fullContent.WriteString(content)
							if onChunk != nil {
								onChunk(content)
							}
						}
					} else if onProgress != nil {
						ev := StreamEvent{
							Type: t,
						}
						onProgress(ev)
					}
				} else {
					if content, ok := eventObj["content"].(string); ok {
						fullContent.WriteString(content)
						if onChunk != nil {
							onChunk(content)
						}
					}
				}
			} else {
				content := data
				fullContent.WriteString(content)
				if onChunk != nil {
					onChunk(content)
				}
			}
		}
	}

	return &ChatResponse{
		Content: fullContent.String(),
		Agent:   p.agentName,
		Done:    true,
	}, nil
}

func (p *KagentiProvider) Chat(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
	return p.StreamChat(ctx, req, nil)
}

func (p *KagentiProvider) controllerReachable(ctx context.Context) bool {
	if p.baseURL == "" {
		return false
	}

	for _, path := range []string{"/health", "/healthz", "/api/health"} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.baseURL+path, nil)
		if err != nil {
			continue
		}
		resp, err := p.client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 400 {
			return true
		}
	}

	return false
}

func (p *KagentiProvider) streamCandidateURLs() []string {
	if p.directAgent != "" {
		base := strings.TrimRight(p.directAgent, "/")
		urls := make([]string, 0, 5)

		if p.namespace != "" && p.agentName != "" {
			urls = append(urls,
				fmt.Sprintf("%s/api/chat/%s/%s/stream", base, p.namespace, p.agentName),
				fmt.Sprintf("%s/chat/%s/%s/stream", base, p.namespace, p.agentName),
			)
		}

		urls = append(urls,
			base+"/api/chat/stream",
			base+"/chat/stream",
			base+"/stream",
		)

		return urls
	}

	if p.baseURL == "" {
		return nil
	}

	chatBasePath := p.chatBasePath
	if chatBasePath == "" {
		chatBasePath = "/api"
	}

	return []string{
		fmt.Sprintf("%s%s/chat/%s/%s/stream", p.baseURL, chatBasePath, p.namespace, p.agentName),
	}
}
