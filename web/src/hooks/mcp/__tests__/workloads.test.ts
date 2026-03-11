import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { STORAGE_KEY_TOKEN } from "../../../lib/constants";

const mockApiGet = vi.hoisted(() => vi.fn());
const mockFetchSSE = vi.hoisted(() => vi.fn());
const mockReportAgentDataSuccess = vi.hoisted(() => vi.fn());
const mockIsAgentUnavailable = vi.hoisted(() => vi.fn(() => false));
const mockIsDemoMode = vi.hoisted(() => vi.fn(() => false));
const mockIsBackendUnavailable = vi.hoisted(() => vi.fn(() => false));
const mockRegisterRefetch = vi.hoisted(() => vi.fn());
const cacheResetHandlers = vi.hoisted(
  () => new Map<string, () => void | Promise<void>>(),
);
const refetchHandlers = vi.hoisted(
  () => new Map<string, () => void | Promise<void>>(),
);
const mockKubectlProxy = vi.hoisted(() => ({
  getPodIssues: vi.fn(),
  getDeployments: vi.fn(),
}));
const mockClusterCacheRef = vi.hoisted(() => ({
  clusters: [] as Array<{ name: string; context?: string }>,
}));

vi.mock("../../../lib/api", () => ({
  api: {
    get: mockApiGet,
  },
  isBackendUnavailable: mockIsBackendUnavailable,
}));

vi.mock("../../../lib/sseClient", () => ({
  fetchSSE: mockFetchSSE,
}));

vi.mock("../../useLocalAgent", () => ({
  reportAgentDataSuccess: mockReportAgentDataSuccess,
  isAgentUnavailable: mockIsAgentUnavailable,
}));

vi.mock("../../../lib/demoMode", () => ({
  isDemoMode: mockIsDemoMode,
}));

vi.mock("../../../lib/modeTransition", () => ({
  registerCacheReset: vi.fn(
    (key: string, handler: () => void | Promise<void>) => {
      cacheResetHandlers.set(key, handler);
    },
  ),
  registerRefetch: vi.fn((key: string, handler: () => void | Promise<void>) => {
    refetchHandlers.set(key, handler);
    mockRegisterRefetch(key, handler);
    return () => {
      refetchHandlers.delete(key);
    };
  }),
}));

vi.mock("../../../lib/kubectlProxy", () => ({
  kubectlProxy: mockKubectlProxy,
}));

vi.mock("../shared", () => ({
  REFRESH_INTERVAL_MS: 120000,
  MIN_REFRESH_INDICATOR_MS: 0,
  getEffectiveInterval: (value: number) => value,
  LOCAL_AGENT_URL: "http://localhost:8585",
  clusterCacheRef: mockClusterCacheRef,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadWorkloadsModule() {
  return import("../workloads");
}

function makeFetchResponse(data: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(data),
  } as unknown as Response;
}

function setPodsStorageCache(
  pods: Array<Record<string, unknown>>,
  cluster?: string,
  namespace?: string,
) {
  localStorage.setItem(
    "kubestellar-pods-cache",
    JSON.stringify({
      data: pods,
      timestamp: "2026-03-10T00:00:00.000Z",
      key: `pods:${cluster || "all"}:${namespace || "all"}`,
    }),
  );
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("workload hooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    cacheResetHandlers.clear();
    refetchHandlers.clear();
    mockClusterCacheRef.clusters = [];
    mockIsAgentUnavailable.mockReturnValue(false);
    mockIsDemoMode.mockReturnValue(false);
    mockIsBackendUnavailable.mockReturnValue(false);
    mockApiGet.mockReset();
    mockFetchSSE.mockReset();
    mockReportAgentDataSuccess.mockReset();
    mockKubectlProxy.getPodIssues.mockReset();
    mockKubectlProxy.getDeployments.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("usePods", () => {
    it("returns initial loading state when no cache exists", async () => {
      const pending = deferred<Array<{ name: string; restarts: number }>>();
      mockFetchSSE.mockReturnValue(pending.promise);
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePods());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.pods).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it("returns cached data immediately when cache exists", async () => {
      setPodsStorageCache([
        {
          name: "cached-pod",
          restarts: 4,
          namespace: "default",
          cluster: "alpha",
        },
      ]);
      mockFetchSSE.mockReturnValue(new Promise(() => {}));
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePods());

      expect(result.current.isLoading).toBe(false);
      expect(result.current.pods).toEqual([
        expect.objectContaining({ name: "cached-pod", restarts: 4 }),
      ]);
      expect(result.current.lastUpdated).toBeInstanceOf(Date);
    });

    it("fetches pods from the stream endpoint and passes cluster and namespace params", async () => {
      mockFetchSSE.mockResolvedValue([
        { name: "pod-b", restarts: 1, cluster: "alpha", namespace: "apps" },
      ]);
      const { usePods } = await loadWorkloadsModule();

      renderHook(() => usePods("alpha", "apps"));

      await waitFor(() => {
        expect(mockFetchSSE).toHaveBeenCalledWith(
          expect.objectContaining({
            url: "/api/mcp/pods/stream",
            params: { cluster: "alpha", namespace: "apps" },
            itemsKey: "pods",
          }),
        );
      });
    });

    it("sorts pods by restarts", async () => {
      mockFetchSSE.mockResolvedValue([
        { name: "pod-a", restarts: 2, cluster: "alpha", namespace: "apps" },
        { name: "pod-c", restarts: 9, cluster: "alpha", namespace: "apps" },
        { name: "pod-b", restarts: 4, cluster: "alpha", namespace: "apps" },
      ]);
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePods());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.pods.map((pod) => pod.name)).toEqual([
        "pod-c",
        "pod-b",
        "pod-a",
      ]);
    });

    it("sorts pods by name", async () => {
      mockFetchSSE.mockResolvedValue([
        { name: "zeta", restarts: 1, cluster: "alpha", namespace: "apps" },
        { name: "alpha", restarts: 20, cluster: "alpha", namespace: "apps" },
        { name: "beta", restarts: 3, cluster: "alpha", namespace: "apps" },
      ]);
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() =>
        usePods(undefined, undefined, "name"),
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.pods.map((pod) => pod.name)).toEqual([
        "alpha",
        "beta",
        "zeta",
      ]);
    });

    it("respects the limit argument", async () => {
      mockFetchSSE.mockResolvedValue([
        { name: "pod-1", restarts: 9 },
        { name: "pod-2", restarts: 8 },
        { name: "pod-3", restarts: 7 },
      ]);
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() =>
        usePods(undefined, undefined, "restarts", 2),
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.pods).toHaveLength(2);
      expect(result.current.pods.map((pod) => pod.name)).toEqual([
        "pod-1",
        "pod-2",
      ]);
    });

    it("falls back to demo pods on first fetch failure without cache", async () => {
      mockFetchSSE.mockRejectedValue(new Error("boom"));
      const { usePods } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePods());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch pods"),
      );
      expect(result.current.pods).toHaveLength(10);
      expect(result.current.pods[0].name).toBe("api-server-7d8f9c6b5-x2k4m");
    });

    it("preserves stale data on refresh failure with cache", async () => {
      mockFetchSSE
        .mockResolvedValueOnce([
          {
            name: "stale-pod",
            restarts: 3,
            namespace: "apps",
            cluster: "alpha",
          },
        ])
        .mockRejectedValueOnce(new Error("stream failed"));
      const { usePods } = await loadWorkloadsModule();

      const initial = renderHook(() => usePods("alpha", "apps"));
      await waitFor(() =>
        expect(initial.result.current.pods[0]?.name).toBe("stale-pod"),
      );
      initial.unmount();

      const { result } = renderHook(() => usePods("alpha", "apps"));

      await flushMicrotasks();
      expect(result.current.pods).toEqual([
        expect.objectContaining({ name: "stale-pod", restarts: 3 }),
      ]);
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });

    it("polls every refresh interval and clears the interval on unmount", async () => {
      vi.useFakeTimers();
      mockFetchSSE.mockResolvedValue([]);
      const { usePods } = await loadWorkloadsModule();

      const { unmount } = renderHook(() => usePods());

      await flushMicrotasks();
      expect(mockFetchSSE).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(120000);
      });
      await flushMicrotasks();
      expect(mockFetchSSE).toHaveBeenCalledTimes(2);

      unmount();

      await act(async () => {
        vi.advanceTimersByTime(120000);
      });
      await flushMicrotasks();
      expect(mockFetchSSE).toHaveBeenCalledTimes(2);
    });
  });

  describe("useDeployments", () => {
    it("returns initial loading state when no cache exists", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise(() => {}),
      );
      const { useDeployments } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeployments("alpha", "apps"));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.deployments).toEqual([]);
    });

    it("returns deployment data from the local agent path", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          deployments: [{ name: "agent-deploy", namespace: "apps" }],
        }),
      );
      const { useDeployments } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeployments("alpha", "apps"));

      await waitFor(() => expect(result.current.deployments).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/deployments?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
      expect(result.current.deployments[0]).toEqual(
        expect.objectContaining({ name: "agent-deploy", cluster: "alpha" }),
      );
    });

    it("falls back to kubectl proxy when the local agent path fails", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("agent down"),
      );
      mockClusterCacheRef.clusters = [{ name: "alpha", context: "ctx-alpha" }];
      mockKubectlProxy.getDeployments.mockResolvedValue([
        { name: "proxy-deploy", namespace: "apps" },
      ]);
      const { useDeployments } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeployments("alpha", "apps"));

      await waitFor(() => expect(result.current.deployments).toHaveLength(1));
      expect(mockKubectlProxy.getDeployments).toHaveBeenCalledWith(
        "ctx-alpha",
        "apps",
      );
      expect(result.current.deployments[0]).toEqual(
        expect.objectContaining({ name: "proxy-deploy", cluster: "alpha" }),
      );
    });

    it("falls back to the REST API path and passes cluster and namespace", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("agent down"))
        .mockResolvedValueOnce(
          makeFetchResponse({
            deployments: [{ name: "rest-deploy", cluster: "alpha" }],
          }),
        );
      mockKubectlProxy.getDeployments.mockRejectedValue(
        new Error("proxy down"),
      );
      localStorage.setItem(STORAGE_KEY_TOKEN, "test-token");
      const { useDeployments } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeployments("alpha", "apps"));

      await waitFor(() => expect(result.current.deployments).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        "/api/mcp/deployments?cluster=alpha&namespace=apps",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
      expect(result.current.deployments[0].name).toBe("rest-deploy");
    });

    it("refetch re-triggers fetching", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          deployments: [{ name: "deploy-1", namespace: "apps" }],
        }),
      );
      const { useDeployments } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeployments("alpha", "apps"));

      await waitFor(() => expect(result.current.deployments).toHaveLength(1));
      await act(async () => {
        await result.current.refetch();
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("clears state and reloads when cluster or namespace changes", async () => {
      const secondFetch = deferred<Response>();
      (globalThis.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(
          makeFetchResponse({
            deployments: [{ name: "alpha-deploy", namespace: "apps" }],
          }),
        )
        .mockReturnValueOnce(secondFetch.promise);
      const { useDeployments } = await loadWorkloadsModule();

      const { result, rerender } = renderHook(
        ({ cluster, namespace }: { cluster?: string; namespace?: string }) =>
          useDeployments(cluster, namespace),
        { initialProps: { cluster: "alpha", namespace: "apps" } },
      );

      await waitFor(() =>
        expect(result.current.deployments[0]?.name).toBe("alpha-deploy"),
      );

      act(() => {
        rerender({ cluster: "beta", namespace: "ops" });
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
        expect(result.current.deployments).toEqual([]);
      });

      secondFetch.resolve(
        makeFetchResponse({
          deployments: [{ name: "beta-deploy", namespace: "ops" }],
        }),
      );
      await waitFor(() =>
        expect(result.current.deployments[0]?.name).toBe("beta-deploy"),
      );
    });
  });

  describe("usePodIssues", () => {
    it("returns issues from kubectlProxy.getPodIssues when cluster-specific fetch succeeds", async () => {
      mockClusterCacheRef.clusters = [{ name: "alpha", context: "ctx-alpha" }];
      mockKubectlProxy.getPodIssues.mockResolvedValue([
        { name: "pod-a", issues: ["CrashLoopBackOff"] },
      ]);
      const { usePodIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePodIssues("alpha", "apps"));

      await waitFor(() => expect(result.current.issues).toHaveLength(1));
      expect(mockKubectlProxy.getPodIssues).toHaveBeenCalledWith(
        "ctx-alpha",
        "apps",
      );
      expect(mockFetchSSE).not.toHaveBeenCalled();
    });

    it("falls back to the pod issues stream when proxy fetch fails", async () => {
      mockKubectlProxy.getPodIssues.mockRejectedValue(new Error("proxy down"));
      mockFetchSSE.mockResolvedValue([{ name: "pod-b", issues: ["Pending"] }]);
      const { usePodIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePodIssues("alpha", "apps"));

      await waitFor(() => expect(result.current.issues).toHaveLength(1));
      expect(mockFetchSSE).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/mcp/pod-issues/stream",
          params: { cluster: "alpha", namespace: "apps" },
          itemsKey: "issues",
        }),
      );
    });

    it("returns issues: [] on empty response", async () => {
      mockFetchSSE.mockResolvedValue([]);
      const { usePodIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePodIssues());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.issues).toEqual([]);
    });

    it("returns Failed to fetch pod issues on first fetch failure without cache", async () => {
      mockFetchSSE.mockRejectedValue(new Error("stream down"));
      const { usePodIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => usePodIssues());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch pod issues"),
      );
      expect(result.current.issues).toEqual([]);
    });
  });

  describe("useDeploymentIssues", () => {
    it("returns issues from the deployment issues stream", async () => {
      mockFetchSSE.mockResolvedValue([
        { name: "deployment-a", reason: "Unavailable" },
      ]);
      const { useDeploymentIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeploymentIssues("alpha", "apps"));

      await waitFor(() => expect(result.current.issues).toHaveLength(1));
      expect(mockFetchSSE).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/mcp/deployment-issues/stream",
          params: { cluster: "alpha", namespace: "apps" },
          itemsKey: "issues",
        }),
      );
    });

    it("returns issues: [] on empty response", async () => {
      mockFetchSSE.mockResolvedValue([]);
      const { useDeploymentIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeploymentIssues());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.issues).toEqual([]);
    });

    it("returns demo deployment issues on first fetch failure without cache", async () => {
      mockFetchSSE.mockRejectedValue(new Error("stream down"));
      const { useDeploymentIssues } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDeploymentIssues());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch deployment issues"),
      );
      expect(result.current.issues).toHaveLength(2);
      expect(result.current.issues[0].name).toBe("api-gateway");
    });
  });

  describe("other workload hooks", () => {
    it("useHPAs returns hpas from the agent response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({ hpas: [{ name: "hpa-a", namespace: "apps" }] }),
      );
      const { useHPAs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useHPAs("alpha", "apps"));

      await waitFor(() => expect(result.current.hpas).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/hpas?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("useHPAs returns an error state on failure", async () => {
      mockIsAgentUnavailable.mockReturnValue(true);
      mockApiGet.mockRejectedValue(new Error("api down"));
      const { useHPAs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useHPAs());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch HPAs"),
      );
      expect(result.current.hpas).toEqual([]);
    });

    it("useJobs returns jobs from the SSE response", async () => {
      mockFetchSSE.mockResolvedValue([{ name: "job-a", namespace: "apps" }]);
      const { useJobs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useJobs());

      await waitFor(() => expect(result.current.jobs).toHaveLength(1));
      expect(mockFetchSSE).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/mcp/jobs/stream",
          itemsKey: "jobs",
        }),
      );
    });

    it("useJobs returns an error state on failure", async () => {
      mockFetchSSE.mockRejectedValue(new Error("stream down"));
      const { useJobs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useJobs());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch jobs"),
      );
      expect(result.current.jobs).toEqual([]);
    });

    it("useReplicaSets returns replicasets from the agent response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          replicasets: [{ name: "rs-a", namespace: "apps" }],
        }),
      );
      const { useReplicaSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useReplicaSets("alpha", "apps"));

      await waitFor(() => expect(result.current.replicasets).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/replicasets?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("useReplicaSets returns an error state on failure", async () => {
      mockIsAgentUnavailable.mockReturnValue(true);
      mockApiGet.mockRejectedValue(new Error("api down"));
      const { useReplicaSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useReplicaSets());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch ReplicaSets"),
      );
      expect(result.current.replicasets).toEqual([]);
    });

    it("useStatefulSets returns statefulsets from the agent response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          statefulsets: [{ name: "sts-a", namespace: "apps" }],
        }),
      );
      const { useStatefulSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useStatefulSets("alpha", "apps"));

      await waitFor(() => expect(result.current.statefulsets).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/statefulsets?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("useStatefulSets returns an error state on failure", async () => {
      mockIsAgentUnavailable.mockReturnValue(true);
      mockApiGet.mockRejectedValue(new Error("api down"));
      const { useStatefulSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useStatefulSets());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch StatefulSets"),
      );
      expect(result.current.statefulsets).toEqual([]);
    });

    it("useDaemonSets returns daemonsets from the agent response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          daemonsets: [{ name: "ds-a", namespace: "apps" }],
        }),
      );
      const { useDaemonSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDaemonSets("alpha", "apps"));

      await waitFor(() => expect(result.current.daemonsets).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/daemonsets?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("useDaemonSets returns an error state on failure", async () => {
      mockIsAgentUnavailable.mockReturnValue(true);
      mockApiGet.mockRejectedValue(new Error("api down"));
      const { useDaemonSets } = await loadWorkloadsModule();

      const { result } = renderHook(() => useDaemonSets());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch DaemonSets"),
      );
      expect(result.current.daemonsets).toEqual([]);
    });

    it("useCronJobs returns cronjobs from the agent response", async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          cronjobs: [{ name: "cron-a", namespace: "apps" }],
        }),
      );
      const { useCronJobs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useCronJobs("alpha", "apps"));

      await waitFor(() => expect(result.current.cronjobs).toHaveLength(1));
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8585/cronjobs?cluster=alpha&namespace=apps",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("useCronJobs returns an error state on failure", async () => {
      mockIsAgentUnavailable.mockReturnValue(true);
      mockApiGet.mockRejectedValue(new Error("api down"));
      const { useCronJobs } = await loadWorkloadsModule();

      const { result } = renderHook(() => useCronJobs());

      await waitFor(() =>
        expect(result.current.error).toBe("Failed to fetch CronJobs"),
      );
      expect(result.current.cronjobs).toEqual([]);
    });
  });

  describe("shared workload cache lifecycle", () => {
    it("subscribed hooks enter loading state and clear visible data when the shared reset fires", async () => {
      setPodsStorageCache(
        [
          {
            name: "cached-pod",
            restarts: 2,
            namespace: "apps",
            cluster: "alpha",
          },
        ],
        "alpha",
        "apps",
      );
      mockFetchSSE.mockReturnValue(new Promise(() => {}));
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeFetchResponse({
          deployments: [{ name: "deploy-a", namespace: "apps" }],
        }),
      );
      const { usePods, useDeployments } = await loadWorkloadsModule();

      const podsHook = renderHook(() => usePods("alpha", "apps"));
      const deploymentsHook = renderHook(() => useDeployments("alpha", "apps"));

      await waitFor(() =>
        expect(deploymentsHook.result.current.deployments).toHaveLength(1),
      );
      expect(podsHook.result.current.pods).toHaveLength(1);

      const reset = cacheResetHandlers.get("workloads");
      expect(reset).toBeTypeOf("function");

      await act(async () => {
        await reset?.();
      });

      expect(podsHook.result.current.isLoading).toBe(true);
      expect(podsHook.result.current.pods).toEqual([]);
      expect(podsHook.result.current.lastUpdated).toBeNull();
      expect(deploymentsHook.result.current.isLoading).toBe(true);
      expect(deploymentsHook.result.current.deployments).toEqual([]);
      expect(deploymentsHook.result.current.lastUpdated).toBeNull();
    });
  });
});
