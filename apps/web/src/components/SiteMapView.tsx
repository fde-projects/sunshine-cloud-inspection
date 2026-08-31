"use client";

import { useEffect, useRef, useState } from 'react';
import type { LatLngBoundsExpression, LatLngExpression, Map as LeafletMap } from 'leaflet';

export interface SiteMarker {
  id: string;
  name: string;
  city?: string;
  latitude: number;
  longitude: number;
  deviceCount?: number;
}

interface SiteMapViewProps {
  markers: SiteMarker[];
  height?: number;
}

type LeafletDefault = typeof import('leaflet').default;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char];
  });
}

/** 仪表盘网格分布（Leaflet + 高德瓦片）；leaflet 仅在浏览器里加载 */
export default function SiteMapView({ markers, height = 360 }: SiteMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<LeafletDefault | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const hasMarkers = markers.length > 0;

  useEffect(() => {
    if (!hasMarkers || !containerRef.current) return;
    let cancelled = false;

    void (async () => {
      const leaflet = await import('leaflet');
      await import('leaflet/dist/leaflet.css');
      const { createGaodeTileLayer } = await import('../utils/gaodeTileLayer');
      if (cancelled || !containerRef.current) return;

      const L = leaflet.default;
      const map = L.map(containerRef.current).setView([39.9042, 116.4074], 5);
      createGaodeTileLayer().addTo(map);
      leafletRef.current = L;
      mapRef.current = map;
      setMapReady(true);
    })();

    return () => {
      cancelled = true;
      setMapReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, [hasMarkers]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!mapReady || !map || !L) return;

    map.eachLayer((layer) => {
      if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    if (!markers.length) return;

    const bounds: LatLngExpression[] = [];
    markers.forEach((m) => {
      const latlng: LatLngExpression = [m.latitude, m.longitude];
      bounds.push(latlng);
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:12px;height:12px;background:#1a5f4a;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      L.marker(latlng, { icon })
        .addTo(map)
        .bindPopup(
          `<strong>${escapeHtml(m.name)}</strong><br/>${escapeHtml(m.city || '')}<br/>设备 ${m.deviceCount ?? 0} 台`,
        );
    });

    if (bounds.length > 1) {
      map.fitBounds(bounds as LatLngBoundsExpression, { padding: [40, 40] });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 10);
    }
  }, [markers, mapReady]);

  return (
    <div>
      {!hasMarkers ? (
        <div
          style={{
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#999',
          }}
        >
          暂无网格坐标数据
        </div>
      ) : (
        <div ref={containerRef} style={{ height, width: '100%', borderRadius: 8 }} />
      )}
    </div>
  );
}
