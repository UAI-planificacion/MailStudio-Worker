export enum Priority {
    NORMAL = "NORMAL",
    HIGH   = "HIGH"
}


export interface PayloadEmail {
    student        : PayloadStudent;
    templateId     : string;
    subject        : string;
    notificationId : string;
    priority?      : Priority | null;
    cc?            : string[] | null;
    bcc?           : string[] | null;
}


export interface PayloadStudent {
    email   : string;
    name?   : string | null;
}


export interface PayloadRecurrent {
    workflowId : string;
    cronRule   : string;
}

export interface Template {
    id : string;
    content : string;
}


export interface Workflow {
    id              : string;
    name            : string;
    students        : PayloadStudent[];
    notificationId  : string;
    subject         : string;
    cc?             : string[] | null;
    bcc?            : string[] | null;
    status          : 'ACTIVE' | 'INACTIVE';
    template        : Template;
}
