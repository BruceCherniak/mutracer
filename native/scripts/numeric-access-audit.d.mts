export interface NumericAccessSite {
  file:string;line:number;column:number;expression:string;type:string;function:string;
  localLoop:boolean;reachable:boolean;calledFromLoop:boolean;
}
export function auditNumericAccess(stage:string,entry:string,enforce?:boolean):{
  entry:string;remaining:NumericAccessSite[];unreachableTemplates:NumericAccessSite[];violations:NumericAccessSite[];
};
