import { computeDifference } from '../../alva-util';
import { Box, Image, Link, Page, Text } from './builtins';
import * as Fuse from 'fuse.js';
import { isEqual } from 'lodash';
import * as Mobx from 'mobx';
import { Pattern, PatternSlot } from '../pattern';
import { AnyPatternProperty, PatternEnumProperty, PatternProperty } from '../pattern-property';
import { Project } from '../project';
import * as Types from '../../types';
import * as uuid from 'uuid';

export interface PatternLibraryInit {
	bundleId: string;
	bundle: string;
	description: string;
	id: string;
	name: string;
	origin: Types.PatternLibraryOrigin;
	patternProperties: AnyPatternProperty[];
	patterns: Pattern[];
	state: Types.PatternLibraryState;
}

export interface BuiltInContext {
	options: PatternLibraryCreateOptions;
	patternLibrary: PatternLibrary;
}

export interface BuiltInResult {
	pattern: Pattern;
	properties: AnyPatternProperty[];
}

export interface PatternLibraryCreateOptions {
	getGloablEnumOptionId(enumId: string, contextId: string): string;
	getGlobalPatternId(contextId: string): string;
	getGlobalPropertyId(patternId: string, contextId: string): string;
	getGlobalSlotId(patternId: string, contextId: string): string;
}

export class PatternLibrary {
	@Mobx.observable private bundleId: string;
	@Mobx.observable private bundle: string;
	@Mobx.observable private description: string;
	@Mobx.observable private fuse: Fuse;
	@Mobx.observable private id: string;
	@Mobx.observable private name: string;
	@Mobx.observable private patternProperties: Map<string, AnyPatternProperty> = new Map();
	@Mobx.observable private patterns: Map<string, Pattern> = new Map();
	@Mobx.observable private origin: Types.PatternLibraryOrigin;
	@Mobx.observable private state: Types.PatternLibraryState;

	public constructor(init: PatternLibraryInit) {
		this.bundleId = init.bundleId;
		this.bundle = init.bundle;
		this.description = init.description;
		this.id = init.id || uuid.v4();
		this.name = init.name;
		this.origin = init.origin;
		init.patterns.forEach(pattern => this.patterns.set(pattern.getId(), pattern));
		init.patternProperties.forEach(prop => this.patternProperties.set(prop.getId(), prop));
		this.state = init.state;

		this.updateSearch();
	}

	public static create(init: PatternLibraryInit): PatternLibrary {
		const options = {
			getGloablEnumOptionId: () => uuid.v4(),
			getGlobalPatternId: () => uuid.v4(),
			getGlobalPropertyId: () => uuid.v4(),
			getGlobalSlotId: () => uuid.v4()
		};

		const patternLibrary = new PatternLibrary(init);

		if (init.origin === Types.PatternLibraryOrigin.BuiltIn) {
			const link = Link({ options, patternLibrary });
			const page = Page({ options, patternLibrary });
			const image = Image({ options, patternLibrary });
			const text = Text({ options, patternLibrary });
			const box = Box({ options, patternLibrary });

			[page.pattern, text.pattern, box.pattern, image.pattern, link.pattern].forEach(pattern => {
				patternLibrary.addPattern(pattern);
			});

			[
				...page.properties,
				...image.properties,
				...text.properties,
				...box.properties,
				...link.properties
			].forEach(property => {
				patternLibrary.addProperty(property);
			});
		}

		return patternLibrary;
	}

	public static from(serialized: Types.SerializedPatternLibrary): PatternLibrary {
		const state = deserializeState(serialized.state);

		const patternLibrary = new PatternLibrary({
			bundleId: serialized.bundleId,
			bundle: serialized.bundle,
			description: serialized.description,
			id: serialized.id,
			name: serialized.name,
			origin: deserializeOrigin(serialized.origin),
			patterns: [],
			patternProperties: serialized.patternProperties.map(p => PatternProperty.from(p)),
			state
		});

		serialized.patterns.forEach(pattern => {
			patternLibrary.addPattern(Pattern.from(pattern, { patternLibrary }));
		});

		return patternLibrary;
	}

	@Mobx.action
	public import(analysis: Types.LibraryAnalysis, { project }: { project: Project }): void {
		const patternsBefore = this.getPatterns();

		const patternChanges = computeDifference({
			before: patternsBefore,
			after: analysis.patterns.map(item => Pattern.from(item.pattern, { patternLibrary: this }))
		});

		patternChanges.removed.map(change => {
			this.removePattern(change.before);
		});

		patternChanges.added.map(change => {
			this.addPattern(change.after);
		});

		patternChanges.changed.map(change => {
			change.before.update(change.after, { patternLibrary: this });
		});

		const propMap: Map<string, Pattern> = new Map();

		const props = analysis.patterns.reduce((p: AnyPatternProperty[], patternAnalysis) => {
			const pattern = Pattern.from(patternAnalysis.pattern, { patternLibrary: this });

			patternAnalysis.properties.forEach(prop => {
				const patternProperty = PatternProperty.from(prop);
				p.push(patternProperty);
				propMap.set(patternProperty.getId(), pattern);
			});
			return p;
		}, []);

		const propChanges = computeDifference({
			before: this.getPatternProperties(),
			after: props
		});

		propChanges.removed.map(change => {
			this.removeProperty(change.before);
		});

		propChanges.added.map(change => {
			const pattern = propMap.get(change.after.getId());
			const p = pattern ? this.getPatternById(pattern.getId()) : undefined;

			this.addProperty(change.after);

			if (p) {
				p.addProperty(change.after);
			}
		});

		propChanges.changed.map(change => change.before.update(change.after));

		this.setState(Types.PatternLibraryState.Connected);
		this.updateSearch();

		this.setBundle(analysis.bundle);
		this.setBundleId(analysis.id);
	}
	public equals(b: PatternLibrary): boolean {
		return isEqual(this.toJSON(), b.toJSON());
	}

	public addPattern(pattern: Pattern): void {
		this.patterns.set(pattern.getId(), pattern);
		this.updateSearch();
	}

	public addProperty(property: AnyPatternProperty): void {
		this.patternProperties.set(property.getId(), property);
	}

	public assignEnumOptionId(enumId: string, contextId: string): string {
		const enumProperty = this.getPatternPropertyById(enumId) as PatternEnumProperty;

		if (!enumProperty) {
			return uuid.v4();
		}

		const option = enumProperty.getOptionByContextId(contextId);
		return option ? option.getId() : uuid.v4();
	}

	public assignPatternId(contextId: string): string {
		const pattern = this.getPatternByContextId(contextId);
		return pattern ? pattern.getId() : uuid.v4();
	}

	public assignPropertyId(patternId: string, contextId: string): string {
		const pattern = this.getPatternById(patternId);
		if (!pattern) {
			return uuid.v4();
		}
		const property = pattern.getPropertyByContextId(contextId);
		return property ? property.getId() : uuid.v4();
	}

	public assignSlotId(patternId: string, contextId: string): string {
		const pattern = this.getPatternById(patternId);
		if (!pattern) {
			return uuid.v4();
		}
		const slot = pattern.getSlots().find(s => s.getContextId() === contextId);
		return slot ? slot.getId() : uuid.v4();
	}

	public getDescription(): string {
		return this.description;
	}

	public getBundle(): string {
		return this.bundle;
	}

	public getBundleId(): string {
		return this.bundleId;
	}

	public getCapabilites(): Types.LibraryCapability[] {
		const isUserProvided = this.origin === Types.PatternLibraryOrigin.UserProvided;

		if (!isUserProvided) {
			return [];
		}

		const isConnected = this.state === Types.PatternLibraryState.Connected;

		return [
			isConnected && Types.LibraryCapability.Disconnect,
			isConnected && Types.LibraryCapability.Update,
			isConnected && Types.LibraryCapability.SetPath,
			Types.LibraryCapability.Reconnect
		].filter(
			(capability): capability is Types.LibraryCapability => typeof capability !== 'undefined'
		);
	}

	public getId(): string {
		return this.id;
	}

	public getName(): string {
		return this.name;
	}

	public getOrigin(): Types.PatternLibraryOrigin {
		return this.origin;
	}

	public getPatternByContextId(contextId: string): Pattern | undefined {
		return this.getPatterns().find(pattern => pattern.getContextId() === contextId);
	}

	public getPatternById(id: string): Pattern | undefined {
		return this.patterns.get(id);
	}

	public getPatternByType(type: Types.PatternType): Pattern {
		return this.getPatterns().find(pattern => pattern.getType() === type) as Pattern;
	}

	public getPatternProperties(): AnyPatternProperty[] {
		return [...this.patternProperties.values()];
	}

	public getPatternPropertyById(id: string): AnyPatternProperty | undefined {
		return this.getPatternProperties().find(patternProperty => patternProperty.getId() === id);
	}

	public getPatternSlotById(id: string): PatternSlot | undefined {
		return this.getSlots().find(slot => slot.getId() === id);
	}

	public getPatterns(): Pattern[] {
		return [...this.patterns.values()];
	}

	public getSlots(): PatternSlot[] {
		return this.getPatterns().reduce((acc, pattern) => [...acc, ...pattern.getSlots()], []);
	}

	public getState(): Types.PatternLibraryState {
		return this.state;
	}

	public query(term: string): string[] {
		if (term.trim().length === 0) {
			return this.getPatterns().map(p => p.getId());
		}

		return this.fuse.search<Types.SerializedPattern>(term).map(match => match.id);
	}

	@Mobx.action
	public removePattern(pattern: Pattern): void {
		this.patterns.delete(pattern.getId());
	}

	@Mobx.action
	public removeProperty(property: AnyPatternProperty): void {
		this.patternProperties.delete(property.getId());
	}

	@Mobx.action
	public setBundle(bundle: string): void {
		this.bundle = bundle;
	}

	@Mobx.action
	public setBundleId(bundleId: string): void {
		this.bundleId = bundleId;
	}

	@Mobx.action
	public setDescription(description: string): void {
		this.description = description;
	}

	@Mobx.action
	public setName(name: string): void {
		this.name = name;
	}

	@Mobx.action
	public setState(state: Types.PatternLibraryState): void {
		this.state = state;
	}

	public toJSON(): Types.SerializedPatternLibrary {
		return {
			bundleId: this.bundleId,
			bundle: this.bundle,
			description: this.description,
			id: this.id,
			name: this.name,
			origin: serializeOrigin(this.origin),
			patterns: this.getPatterns().map(p => p.toJSON()),
			patternProperties: this.getPatternProperties().map(p => p.toJSON()),
			state: this.state
		};
	}

	@Mobx.action
	public update(b: PatternLibrary): void {
		this.bundleId = b.bundleId;
		this.bundle = b.bundle;
		this.description = b.description;
		this.id = b.id;
		this.name = b.name;
		this.origin = b.origin;
		this.patterns = b.patterns;
		this.patternProperties = b.patternProperties;
		this.state = this.state;
	}

	@Mobx.action
	public updateSearch(): void {
		const registry = this.getPatterns().map(item => item.toJSON());

		this.fuse = new Fuse(registry, {
			keys: ['name']
		});
	}
}

function deserializeState(
	input: 'pristine' | 'connected' | 'disconnected'
): Types.PatternLibraryState {
	switch (input) {
		case 'pristine':
			return Types.PatternLibraryState.Pristine;
		case 'connected':
			return Types.PatternLibraryState.Connected;
		case 'disconnected':
			return Types.PatternLibraryState.Disconnected;
	}
}

function deserializeOrigin(
	input: Types.SerializedPatternLibraryOrigin
): Types.PatternLibraryOrigin {
	switch (input) {
		case 'built-in':
			return Types.PatternLibraryOrigin.BuiltIn;
		case 'user-provided':
			return Types.PatternLibraryOrigin.UserProvided;
	}
	throw new Error(`Unknown pattern library origin: ${input}`);
}

function serializeOrigin(input: Types.PatternLibraryOrigin): Types.SerializedPatternLibraryOrigin {
	switch (input) {
		case Types.PatternLibraryOrigin.BuiltIn:
			return 'built-in';
		case Types.PatternLibraryOrigin.UserProvided:
			return 'user-provided';
	}
	throw new Error(`Unknown pattern library origin: ${input}`);
}
