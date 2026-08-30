"use client";

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { createGaodeTileLayer } from '../utils/gaodeTileLayer';

interface MapPickerProps {
  latitude?: number;
  longitude?: number;
  onChange: (lat: number, lng: number) => void;
  height?: number;
  compact?: boolean;
}

const FALLBACK_LAT = 39.9042;
const FALLBACK_LNG = 116.4074;

function safeLatLng(lat?: number, lng?: number): [number, number] {
  const nextLat = Number(lat);
  const nextLng = Number(lng);
  if (
    Number.isFinite(nextLat) &&
    Number.isFinite(nextLng) &&
    nextLat >= -90 &&
    nextLat <= 90 &&
    nextLng >= -180 &&
    nextLng <= 180
  ) {
    return [nextLat, nextLng];
  }
  return [FALLBACK_LAT, FALLBACK_LNG];
}

/** 地图选点（Leaflet + 高德瓦片） */
export default function MapPicker({
  latitude,
  longitude,
  onChange,
  height = 280,
  compact = false,
}: MapPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const start = safeLatLng(latitude, longitude);
    const map = L.map(containerRef.current, { zoomControl: !compact }).setView(start, 14);
    createGaodeTileLayer().addTo(map);

    const icon = L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;background:#1a5f4a;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });

    const marker = L.marker(start, { icon, draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      onChangeRef.current(Number(pos.lat.toFixed(7)), Number(pos.lng.toFixed(7)));
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      onChangeRef.current(Number(e.latlng.lat.toFixed(7)), Number(e.latlng.lng.toFixed(7)));
    });

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    const next = safeLatLng(latitude, longitude);
    if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return;
    markerRef.current.setLatLng(next);
    mapRef.current.flyTo(next, mapRef.current.getZoom() || 14, {
      duration: 0.6,
    });
  }, [latitude, longitude]);

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid #e8eeea',
        boxShadow: 'inset 0 0 0 1px rgba(26,95,74,.04)',
      }}
    >
      <div ref={containerRef} style={{ height, width: '100%' }} />
    </div>
  );
}
