
export class Box3 {
  min: Float64Array;
  max: Float64Array;

  constructor() {
    this.min = new Float64Array([Infinity, Infinity, Infinity]);
    this.max = new Float64Array([-Infinity, -Infinity, -Infinity]);
  }
}
