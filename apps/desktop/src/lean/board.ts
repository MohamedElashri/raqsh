import type { Card, Drawing, Edge } from "../model";

export type View = { x: number; y: number; zoom: number };
export type Board = Drawing & { nodes: Card[]; edges: Edge[] };
