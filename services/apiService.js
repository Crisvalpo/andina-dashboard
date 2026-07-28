/**
 * API Service Client — Andina Piping Dashboard
 */

export async function fetchData(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
}

if (typeof window !== 'undefined') {
    window.fetchData = fetchData;
}
