import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@databricks/appkit-ui/react';

interface CreateTaskDialogProps {
  open: boolean;
  name: string;
  type: string;
  ingestEnabled: boolean;
  targetCatalog: string;
  targetSchema: string;
  targetTable: string;
  error: string | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onIngestEnabledChange: (value: boolean) => void;
  onTargetCatalogChange: (value: string) => void;
  onTargetSchemaChange: (value: string) => void;
  onTargetTableChange: (value: string) => void;
  onCreate: () => void;
}

export function CreateTaskDialog(props: CreateTaskDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>Set up a shared workflow for your team.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={props.name}
              onChange={(event) => props.onNameChange(event.target.value)}
              placeholder="Monthly receivables"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="automation-type">Type</Label>
            <Select value={props.type} onValueChange={props.onTypeChange}>
              <SelectTrigger id="automation-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allocation_upsert">Receivables collection</SelectItem>
                <SelectItem value="vendor_bank_update">Vendor bank details</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="ingest-enabled">This automation collects &amp; stores data</Label>
            <Switch id="ingest-enabled" checked={props.ingestEnabled} onCheckedChange={props.onIngestEnabledChange} />
          </div>
          {props.ingestEnabled && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="target-catalog">Target catalog</Label>
                <Input
                  id="target-catalog"
                  value={props.targetCatalog}
                  onChange={(event) => props.onTargetCatalogChange(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="target-schema">Target schema</Label>
                <Input
                  id="target-schema"
                  value={props.targetSchema}
                  onChange={(event) => props.onTargetSchemaChange(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="target-table">Target table</Label>
                <Input
                  id="target-table"
                  value={props.targetTable}
                  onChange={(event) => props.onTargetTableChange(event.target.value)}
                />
              </div>
            </div>
          )}
          {props.error && (
            <Alert variant="destructive">
              <AlertDescription>{props.error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={props.creating} onClick={props.onCreate}>
            {props.creating ? 'Creating…' : 'Create automation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
